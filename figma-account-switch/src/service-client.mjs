import { spawn, execFile } from 'node:child_process';
import { readFile, mkdir, open, unlink, stat, realpath } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from './manager.mjs';
import { VERSION } from './version.mjs';
import { promisify } from 'node:util';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = promisify(execFile);
const validServiceInfo = info => !!info && /^http:\/\/127\.0\.0\.1:\d+$/.test(info.origin)
  && /^[a-f0-9]{64}$/.test(info.token) && Number(new URL(info.origin).port) > 0 && Number(new URL(info.origin).port) <= 65535;
export async function requestService(info, action = 'status', data = {}) {
  const response = await fetch(info.origin + (action === 'health' ? '/api/health' : action === 'status' ? '/api/status' : action === 'shutdown' ? '/api/shutdown' : '/api/action'), {
    method: ['health', 'status'].includes(action) ? 'GET' : 'POST',
    headers: { 'X-Figma-Accounts-Session': info.token, 'Content-Type': 'application/json', Origin: info.origin },
    ...(!['health', 'status'].includes(action) ? { body: JSON.stringify({ action, data }) } : {}),
    signal: AbortSignal.timeout(['verify', 'select'].includes(action) ? 300000 : action === 'health' ? 1500 : 60000)
  });
  const value = await response.json();
  if (!response.ok) { const e = new Error(value.error); e.code = value.code; throw e; }
  return value;
}
export async function ensureService({ dir = dataDirectory() } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const runtimeFile = join(dir, 'service.json');
  async function existing() {
    let info, health;
    try {
      info = JSON.parse(await readFile(runtimeFile, 'utf8'));
      if (!validServiceInfo(info)) return null;
      health = await requestService(info, 'health');
    } catch { return null; }
    if (health.name !== 'figma-account-switch') return null;
    if (health.version !== VERSION) {
      const error = new Error('账号面板后台服务版本与已安装插件不一致。请先在插件目录运行 npm run stop，待服务停止后重新打开面板。');
      error.code = 'SERVICE_VERSION_MISMATCH'; throw error;
    }
    return info;
  }
  const found = await existing(); if (found) return found;
  const lock = join(dir, 'launch.lock'); let handle;
  for (let attempt = 0; attempt < 70; attempt++) {
    try { handle = await open(lock, 'wx', 0o600); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if ((await stat(lock)).mtimeMs < Date.now() - 30000) await unlink(lock).catch(() => {});
      const running = await existing(); if (running) return running;
      await sleep(200);
    }
  }
  if (!handle) throw new Error('账号面板正在启动，请稍后重试。');
  try {
    const running = await existing(); if (running) return running;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/service.mjs', import.meta.url))], { detached: true, stdio: 'ignore', env: { ...process.env, FIGMA_ACCOUNTS_DATA_DIR: dir } });
    let error; child.on('error', e => { error = e; }); child.unref();
    for (let i = 0; i < 75; i++) { if (error) throw error; await sleep(200); const info = await existing(); if (info) return info; }
    throw new Error('账号面板启动失败，请运行 npm start 查看本地错误。');
  } finally { await handle.close(); await unlink(lock).catch(() => {}); }
}
export const panelUrl = info => info.origin + '/#session=' + info.token;

// Only remove the exact record being stopped; a newly launched service owns its own record.
export async function removeServiceRecord(dir, info) {
  const path = join(dir, 'service.json');
  const launchLock = join(dir, 'launch.lock');
  let handle;
  try { handle = await open(launchLock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST' || error.code === 'ENOENT') return; throw error; }
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.origin === info.origin && current.token === info.token && current.pid === info.pid) await unlink(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { await handle.close(); await unlink(launchLock).catch(() => {}); }
}

async function stopLegacyService(info) {
  // Old releases have no shutdown endpoint. Verify owner, command AND listening port before signalling.
  if (process.platform !== 'darwin' || !Number.isSafeInteger(info.pid) || info.pid <= 1 || !process.getuid) {
    throw new Error('旧版服务无法安全自动停止。请先退出旧账号面板后台进程，或重启电脑后再打开插件。');
  }
  try {
    const { stdout: processInfo } = await execute('/bin/ps', ['-p', String(info.pid), '-o', 'uid=', '-o', 'command='], { timeout: 5000, maxBuffer: 8192 });
    const match = processInfo.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) !== process.getuid()) throw new Error('Unexpected process owner');
    // ps preserves spaces inside argv. Accept only node followed directly by one absolute script path.
    // Versioned install cache roots are valid; their package manifests establish plugin identity.
    const scriptArgument = match[2].startsWith(process.execPath + ' ')
      ? match[2].slice(process.execPath.length + 1)
      : match[2].match(/^(?:\S*\/)?node (\/.*)$/)?.[1];
    if (!scriptArgument || !isAbsolute(scriptArgument) || !scriptArgument.endsWith('/scripts/service.mjs')) throw new Error('Unexpected command');
    const script = await realpath(scriptArgument);
    const pluginRoot = dirname(dirname(script));
    if (!script.endsWith('/scripts/service.mjs')) throw new Error('Unexpected script');
    const [packageInfo, manifest] = await Promise.all([
      readFile(join(pluginRoot, 'package.json'), 'utf8').then(JSON.parse),
      readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8').then(JSON.parse)
    ]);
    if (packageInfo.name !== 'figma-account-switch' || manifest.name !== 'figma-account-switch') throw new Error('Unexpected plugin');
    const port = new URL(info.origin).port;
    const { stdout: listener } = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(info.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fn'], { timeout: 5000, maxBuffer: 8192 });
    if (!listener.split('\n').includes('p' + info.pid) || !listener.split('\n').includes('n127.0.0.1:' + port)) throw new Error('Unexpected listener');
    const { stdout: currentProcess } = await execute('/bin/ps', ['-p', String(info.pid), '-o', 'uid=', '-o', 'command='], { timeout: 5000, maxBuffer: 8192 });
    if (currentProcess !== processInfo) throw new Error('Process changed during verification');
    // The authenticated health response, matching process and listener establish the target together.
    process.kill(info.pid, 'SIGTERM');
  } catch {
    throw new Error('无法确认旧版服务进程及监听端口，未终止任何进程。请先退出旧账号面板后台进程，或重启电脑后再打开插件。');
  }
}

export async function stopService({ dir = dataDirectory() } = {}) {
  let info;
  try { info = JSON.parse(await readFile(join(dir, 'service.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { stopped: false, message: '账号面板服务未运行。' }; throw error; }
  if (!validServiceInfo(info)) throw new Error('账号面板服务记录无效，未终止任何进程。');
  let health;
  try { health = await requestService(info, 'health'); }
  catch (error) {
    if (error.code === 'SESSION_EXPIRED' || error.name === 'TimeoutError') throw new Error('无法验证账号面板服务，未终止任何进程。');
    if (error.cause?.code !== 'ECONNREFUSED') throw error;
    await removeServiceRecord(dir, info);
    return { stopped: false, message: '账号面板服务已停止。' };
  }
  if (health.name !== 'figma-account-switch') throw new Error('目标不是 Figma 账号面板服务，未终止任何进程。');
  if (health.pid !== undefined) {
    if (health.pid !== info.pid) throw new Error('账号面板进程标识不一致，未终止任何进程。');
    await requestService(info, 'shutdown');
  } else await stopLegacyService(info);
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(100);
    try { await requestService(info, 'health'); }
    catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
      await removeServiceRecord(dir, info);
      return { stopped: true, message: '账号面板服务已停止；账号记录和 Figma 授权已保留。' };
    }
  }
  throw new Error('账号面板服务仍在停止中，请稍后重试。');
}
