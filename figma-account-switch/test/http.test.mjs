import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelServer } from '../src/http.mjs';
import { request } from 'node:http';
import { VERSION } from '../src/version.mjs';

test('local account API rejects missing token, foreign origin and DNS rebinding', async t => {
  let mutations = 0;
  const manager = { async status() { return { accounts: [] }; }, async action() { mutations++; return {}; } };
  const app = createPanelServer(manager); const info = await app.listen(); t.after(() => app.close());
  const url = info.origin + '/api/action';
  const good = { 'Content-Type': 'application/json', 'X-Figma-Accounts-Session': info.token, Origin: info.origin };
  const body = JSON.stringify({ action: 'add', data: { label: 'test' } });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...good, Origin: 'https://evil.example' }, body })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { ...good, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(body);
  });
  assert.equal(rebound, 403);
  assert.equal(mutations, 0);
  assert.equal((await fetch(url, { method: 'POST', headers: good, body })).status, 200); assert.equal(mutations, 1);
  const page = await fetch(info.origin); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(info.origin + '/../../etc/passwd')).status, 404);
});

test('health reports the installed version and shutdown requires the service session', async t => {
  let shutdowns = 0;
  const app = createPanelServer({}, { onShutdown() { shutdowns++; } });
  const info = await app.listen(); t.after(() => app.close());
  const good = { 'Content-Type': 'application/json', 'X-Figma-Accounts-Session': info.token, Origin: info.origin };
  const health = await (await fetch(info.origin + '/api/health', { headers: good })).json();
  assert.equal(health.version, VERSION); assert.equal(health.pid, process.pid);
  const url = info.origin + '/api/shutdown';
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...good, Origin: 'https://evil.example' } })).status, 403);
  assert.equal(shutdowns, 0);
  assert.equal((await fetch(url, { method: 'POST', headers: good })).status, 200);
  assert.equal(shutdowns, 1);
});
