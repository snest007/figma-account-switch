import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ensureService, stopService, removeServiceRecord } from '../src/service-client.mjs';
import { createPanelServer } from '../src/http.mjs';
import { VERSION } from '../src/version.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'figma-service-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function record(dir, info) { await writeFile(join(dir, 'service.json'), JSON.stringify(info), { mode: 0o600 }); }

async function legacyCachedServer(t, { name = 'figma-account-switch', nodeFlags = [] } = {}) {
  const dir = await directory(t);
  const pluginRoot = join(dir, 'cache with spaces', 'figma-account-switch', '0.1.0+codex.test');
  await mkdir(join(pluginRoot, 'scripts'), { recursive: true });
  await mkdir(join(pluginRoot, '.codex-plugin'));
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name, type: 'module' }));
  await writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name }));
  const script = join(pluginRoot, 'scripts', 'service.mjs');
  await writeFile(script, `import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
const token = randomBytes(32).toString('hex');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.headers['x-figma-accounts-session'] !== token) { res.statusCode = 401; res.end(JSON.stringify({ code: 'SESSION_EXPIRED' })); return; }
  res.end(JSON.stringify({ ok: true, name: 'figma-account-switch', version: '0.1.0' }));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ origin: 'http://127.0.0.1:' + server.address().port, token, pid: process.pid })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const child = spawn(process.execPath, [...nodeFlags, script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const lines = createInterface({ input: child.stdout });
  t.after(async () => { lines.close(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Legacy test server timed out')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
  });
  await record(dir, info);
  return { dir, child, exited };
}

test('a running old service blocks reuse without stopping it or replacing its record', async t => {
  const dir = await directory(t);
  const token = randomBytes(32).toString('hex');
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, name: 'figma-account-switch', version: '0.1.0' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const info = { origin: 'http://127.0.0.1:' + server.address().port, token, pid: process.pid };
  await record(dir, info);
  await assert.rejects(ensureService({ dir }), error => error.code === 'SERVICE_VERSION_MISMATCH' && /npm run stop/.test(error.message));
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'service.json'))), info);
  assert.ok(server.listening);
});

test('stop verifies identity before shutdown and preserves account data', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'accounts.json'), '{"version":1,"accounts":{}}');
  const manager = { async status() { return {}; }, async action() { throw new Error('No account actions expected'); } };
  let shutdowns = 0;
  const app = createPanelServer(manager, { onShutdown: async () => { shutdowns++; await app.close(); } });
  const info = { ...await app.listen(), pid: process.pid, version: VERSION };
  t.after(() => app.close());
  await record(dir, info);
  assert.deepEqual(await ensureService({ dir }), info);
  assert.equal((await stopService({ dir })).stopped, true);
  assert.equal(shutdowns, 1);
  await assert.rejects(readFile(join(dir, 'service.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(dir, 'accounts.json'), 'utf8'), '{"version":1,"accounts":{}}');
});

test('stop rejects a reused pid before sending a shutdown request', async t => {
  const dir = await directory(t);
  let shutdowns = 0;
  const app = createPanelServer({}, { onShutdown() { shutdowns++; } });
  const info = { ...await app.listen(), pid: process.pid + 1 };
  t.after(() => app.close());
  await record(dir, info);
  await assert.rejects(stopService({ dir }), /进程标识不一致/);
  assert.equal(shutdowns, 0);
});

test('an old server cannot cause stop to signal an unrelated process named in its record', async t => {
  const dir = await directory(t);
  const token = randomBytes(32).toString('hex');
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, name: 'figma-account-switch', version: '0.1.0' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await record(dir, { origin: 'http://127.0.0.1:' + server.address().port, token, pid: process.pid });
  await assert.rejects(stopService({ dir }), /无法确认旧版服务|无法安全自动停止/);
  assert.ok(server.listening);
});

test('stop supports a legacy service in a versioned plugin cache containing spaces', { skip: process.platform !== 'darwin' }, async t => {
  const { dir, child, exited } = await legacyCachedServer(t);
  const result = await stopService({ dir });
  assert.equal(result.stopped, true);
  await exited;
  assert.equal(child.exitCode, 0);
  await assert.rejects(readFile(join(dir, 'service.json')), { code: 'ENOENT' });
});

test('legacy stop rejects a cache whose manifests identify another plugin', { skip: process.platform !== 'darwin' }, async t => {
  const { dir, child } = await legacyCachedServer(t, { name: 'unrelated-plugin' });
  await assert.rejects(stopService({ dir }), /无法确认旧版服务/);
  assert.equal(child.exitCode, null);
});

test('legacy stop rejects unknown Node command flags', { skip: process.platform !== 'darwin' }, async t => {
  const { dir, child } = await legacyCachedServer(t, { nodeFlags: ['--no-warnings'] });
  await assert.rejects(stopService({ dir }), /无法确认旧版服务/);
  assert.equal(child.exitCode, null);
});

test('cleanup keeps a newly launched service record and respects its launch lock', async t => {
  const dir = await directory(t);
  const old = { origin: 'http://127.0.0.1:1111', token: 'a'.repeat(64), pid: 10 };
  const next = { origin: 'http://127.0.0.1:2222', token: 'b'.repeat(64), pid: 11 };
  await record(dir, next);
  await removeServiceRecord(dir, old);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'service.json'))), next);
  await writeFile(join(dir, 'launch.lock'), '');
  await removeServiceRecord(dir, next);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'service.json'))), next);
});

test('stop rejects untrusted runtime URLs and tokens without opening a connection', async t => {
  const dir = await directory(t);
  for (const info of [{ origin: 'https://evil.example', token: 'a'.repeat(64) }, { origin: 'http://127.0.0.1:1', token: 'bad' }]) {
    await record(dir, info);
    await assert.rejects(stopService({ dir }), /服务记录无效/);
  }
});
