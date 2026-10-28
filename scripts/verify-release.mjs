#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageRelease } from './package-release.mjs';
import { inspectShareFile } from './check-share-safety.mjs';
import { cleanError } from '../figma-account-switch/src/rpc.mjs';

// Verification only uses static MCP discovery and an isolated local HTTP service.
const discoveryMethods = new Set(['initialize', 'mcpServerStatus/list', 'mcpServer/resource/read']);
function rpcClient(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map(); let nextId = 1;
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on('error', () => fail(new Error('无法启动隔离 App Server')));
  child.on('exit', () => fail(new Error('隔离 App Server 已关闭')));
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Verification never grants execution or authentication.' } }) + '\n');
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(cleanError(message.error.message)));
    else item.resolve(message.result);
  });
  return {
    request(method, params = {}) {
      assert.ok(discoveryMethods.has(method), '验证不能调用账号操作或模型推理方法');
      return new Promise((resolveRequest, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('隔离接口超时：' + method)); }, 45000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    notify(method) { child.stdin.write(JSON.stringify({ method }) + '\n'); },
    async close() {
      fail(new Error('验证完成')); lines.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(done => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 2000);
        child.once('exit', () => { clearTimeout(timer); done(); });
        child.kill('SIGTERM');
      });
    }
  };
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error('验证命令失败：' + args.slice(0, 4).join(' ') + '；' + cleanError(result.stderr || result.error?.message || '非零退出状态'));
  return result.stdout;
}

export async function verifyRelease({ archive, reportPath } = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'figma-release-install-')));
  const checks = [];
  let appServer, stopLocalService, serviceDir;
  try {
    const release = archive ? { archive: resolve(archive) } : await packageRelease({ outDir: join(temporary, 'build') });
    const archiveSha256 = createHash('sha256').update(await readFile(release.archive)).digest('hex');
    const entries = execute('unzip', ['-Z1', release.archive]).trim().split('\n');
    const folder = entries[0].split('/')[0];
    assert.match(folder, /^figma-account-switch-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
    for (const entry of entries) {
      assert.ok(entry.startsWith(folder + '/') && !/[\\\0\r]/.test(entry));
      assert.ok(!entry.split('/').some(part => part === '..' || ['.git', 'output', '.research', '.playwright-cli', 'node_modules', 'accounts.json', 'service.json', 'auth.json'].includes(part) || /^\.env(?:\.|$)/.test(part)), '发布包不能包含运行数据或仓库外路径');
    }
    assert.ok(entries.includes(folder + '/.agents/plugins/marketplace.json'));
    assert.ok(entries.includes(folder + '/figma-account-switch/.codex-plugin/plugin.json'));
    checks.push('ZIP 隐藏清单和数据排除');
    const extracted = join(temporary, 'extracted'); await mkdir(extracted);
    execute('unzip', ['-q', release.archive, '-d', extracted]);
    const root = join(extracted, folder);
    const privacyFindings = [];
    for (const entry of entries.filter(item => !item.endsWith('/'))) {
      const path = entry.slice(folder.length + 1);
      privacyFindings.push(...inspectShareFile(path, await readFile(join(root, path))));
    }
    assert.equal(privacyFindings.length, 0, '发布内容隐私检查未通过：' + privacyFindings.map(item => item.path + ':' + item.line + ' ' + item.rule).join(', '));
    checks.push('发布包凭证、会话信息和个人账号资料检查');
    const pkg = JSON.parse(await readFile(join(root, 'figma-account-switch/package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(root, 'figma-account-switch/.codex-plugin/plugin.json'), 'utf8'));
    assert.equal(pkg.version, manifest.version);
    const isolatedCodexDirectory = join(temporary, 'codex-config'); await mkdir(isolatedCodexDirectory);
    serviceDir = join(temporary, 'account-data');
    // CODEX_HOME keeps its intended meaning: a dedicated config/cache home for this test process.
    // HOME and the user's real Codex config, account records and OAuth storage remain untouched.
    const environment = { ...process.env, CODEX_HOME: isolatedCodexDirectory, FIGMA_ACCOUNTS_DATA_DIR: serviceDir };
    const command = process.env.FIGMA_ACCOUNTS_CODEX || 'codex';
    execute(command, ['plugin', 'marketplace', 'add', root, '--json'], { env: environment, cwd: temporary });
    execute(command, ['plugin', 'add', 'figma-account-switch@qiang-plugins', '--json'], { env: environment, cwd: temporary });
    const cache = join(isolatedCodexDirectory, 'plugins/cache/qiang-plugins/figma-account-switch');
    let installed;
    for (const version of await readdir(cache)) {
      const candidate = join(cache, version);
      try {
        const local = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
        if (local.version === pkg.version) { installed = candidate; break; }
      } catch { /* Not an installed version folder. */ }
    }
    assert.ok(installed, '隔离缓存中应有已安装的插件副本');
    const doctor = JSON.parse(execute(process.execPath, [join(installed, 'scripts/doctor.mjs'), '--json'], { env: environment, cwd: temporary }));
    assert.ok(doctor.ok, '安装副本的环境检查应通过');
    checks.push('隔离插件源添加、安装缓存和环境检查');

    appServer = rpcClient(command, ['app-server', '--stdio', '-c', 'features.apps=false'], { env: environment, cwd: temporary });
    const initialized = await appServer.request('initialize', { clientInfo: { name: 'figma_release_verify', title: 'Figma release verification', version: pkg.version }, capabilities: { experimentalApi: true, requestAttestation: false } });
    assert.equal(await realpath(initialized.codexHome), await realpath(isolatedCodexDirectory));
    appServer.notify('initialized');
    const inventory = await appServer.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 100 });
    const server = inventory.data.find(item => Object.values(item.tools || {}).some(tool => tool.name === 'open_accounts_panel' || tool.name?.endsWith('__open_accounts_panel')));
    assert.ok(server, 'Codex 应从已安装插件发现账号管理工具：' + JSON.stringify(inventory.data.map(item => ({ name: item.name, pluginId: item.pluginId, version: item.serverInfo?.version, tools: Object.values(item.tools || {}).map(tool => tool.name), error: cleanError(item.toolsError) }))));
    assert.equal(server.serverInfo.version, pkg.version);
    const panel = Object.values(server.tools).find(tool => tool.name === 'open_accounts_panel' || tool.name?.endsWith('__open_accounts_panel'));
    assert.deepEqual(panel._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    const ui = await appServer.request('mcpServer/resource/read', { server: server.name, uri: panel._meta.ui.resourceUri });
    const resource = ui.contents.find(item => typeof item.text === 'string');
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.text, /ui\/initialize/);
    assert.doesNotMatch(resource.text, /<script\b[^>]*\bsrc\s*=/i);
    checks.push('Codex 真实插件启动、工具发现和完整内嵌资源读取');
    await appServer.close(); appServer = undefined;

    const service = await import(pathToFileURL(join(installed, 'src/service-client.mjs')).href);
    stopLocalService = service.stopService;
    const local = await service.ensureService({ dir: serviceDir });
    const health = await service.requestService(local, 'health');
    assert.equal(health.version, pkg.version);
    const response = await fetch(local.origin, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="accounts"/);
    assert.ok((await service.stopService({ dir: serviceDir })).stopped);
    stopLocalService = undefined;
    checks.push('隔离后台服务、网页资源和安全停止');

    const report = { ok: true, version: pkg.version, archiveSha256, node: process.versions.node, codex: doctor.codexVersion, platform: process.platform, checks,
      limitations: ['未进行真实 Figma OAuth 或账号切换', 'UI 资源读取不代表桌面宿主已实际渲染内嵌面板'] };
    if (reportPath) { const path = resolve(reportPath); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n'); }
    return report;
  } finally {
    if (appServer) await appServer.close();
    if (stopLocalService) await stopLocalService({ dir: serviceDir });
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('用法：node scripts/verify-release.mjs [--archive ZIP] [--report JSON]\n\n从临时目录解压、安装和检查插件；默认先生成临时发布包。');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--archive', '--report'].includes(args[i]) || !args[i + 1]) throw new Error('无效参数；使用 --help 查看用法');
    options[args[i] === '--archive' ? 'archive' : 'reportPath'] = args[i + 1];
  }
  console.log(JSON.stringify(await verifyRelease(options), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('发布验证失败：' + cleanError(error.message)); process.exitCode = 1; });
}
