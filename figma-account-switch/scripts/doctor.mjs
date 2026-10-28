#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_RPC_METHODS } from '../src/rpc.mjs';
import { VERSION } from '../src/version.mjs';

const requiredParams = {
  'initialize': ['clientInfo', 'capabilities'],
  'config/read': ['includeLayers', 'cwd'],
  'config/batchWrite': ['edits', 'expectedVersion', 'filePath', 'reloadUserConfig'],
  'mcpServer/oauth/login': ['name', 'timeoutSecs'],
  'mcpServerStatus/list': ['threadId', 'detail', 'limit'],
  'mcpServer/tool/call': ['threadId', 'server', 'tool', 'arguments'],
  'thread/start': ['ephemeral', 'cwd', 'config']
};

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const codexCommand = process.env.FIGMA_ACCOUNTS_CODEX || 'codex';
function run(args) {
  return spawnSync(codexCommand, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
}
const jsonOutput = process.argv.includes('--json');
if (process.argv.slice(2).some(arg => arg !== '--json')) {
  console.error('用法：node scripts/doctor.mjs [--json]');
  process.exit(1);
}

check('macOS', process.platform === 'darwin', process.platform === 'darwin' ? '当前支持的平台' : '当前发布版仅验证 macOS');
check('Node.js', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node + '（要求 22+）');
const cli = run(['--version']);
const codexVersion = cli.status === 0 ? cli.stdout.trim().match(/^codex-cli\s+([\w.+-]+)$/m)?.[1] : undefined;
check('Codex CLI', codexVersion, codexVersion || '无法启动；请检查 PATH 或 FIGMA_ACCOUNTS_CODEX');

try {
  const manifest = JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  check('发布版本', manifest.version === VERSION, '插件和运行代码：' + VERSION);
} catch {
  check('发布版本', false, '缺少或无法读取插件清单');
}

if (codexVersion) {
  const install = run(['plugin', 'add', '--help']);
  const marketplace = run(['plugin', 'marketplace', 'add', '--help']);
  check('GitHub 安装命令', install.status === 0 && marketplace.status === 0, 'plugin add / plugin marketplace add');
  const schemaDir = await mkdtemp(join(tmpdir(), 'figma-accounts-doctor-'));
  try {
    const result = run(['app-server', 'generate-json-schema', '--experimental', '--out', schemaDir]);
    if (result.status !== 0) throw new Error('无法导出实验性协议；请使用兼容版本的 Codex CLI');
    const schema = JSON.parse(await readFile(join(schemaDir, 'ClientRequest.json'), 'utf8'));
    const variants = new Map((schema.oneOf || []).map(item => [item.properties?.method?.enum?.[0], item]));
    const missing = [];
    for (const method of ACCOUNT_RPC_METHODS) {
      const variant = variants.get(method);
      if (!variant) { missing.push(method); continue; }
      let params = variant.properties.params;
      if (params?.$ref) params = schema.definitions?.[params.$ref.split('/').at(-1)];
      for (const field of requiredParams[method] || []) {
        if (!Object.hasOwn(params?.properties || {}, field)) missing.push(method + '.' + field);
      }
    }
    check('App Server 协议', missing.length === 0, missing.length ? '缺少接口：' + missing.join(', ') : ACCOUNT_RPC_METHODS.length + ' 个账号管理方法及必要参数可用');
  } catch (error) {
    check('App Server 协议', false, error.message.startsWith('无法导出') ? error.message : '协议结构不兼容或无法读取');
  } finally {
    await rm(schemaDir, { recursive: true, force: true });
  }
}

const report = { ok: checks.every(item => item.ok), version: VERSION, node: process.versions.node, platform: process.platform, codexVersion: codexVersion || null, checks };
if (jsonOutput) console.log(JSON.stringify(report, null, 2));
else {
  console.log('Figma Accounts ' + VERSION + ' 环境检查');
  for (const item of checks) console.log((item.ok ? '通过' : '失败') + ' · ' + item.name + '：' + item.detail);
  console.log('此检查仅验证本地环境和协议，不执行 OAuth、账号切换或模型请求。');
}
if (!report.ok) process.exitCode = 1;
