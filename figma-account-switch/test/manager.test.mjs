import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager, FIGMA_URL, HOSTED_FIGMA, parseIdentity } from '../src/manager.mjs';
import { CodexRpc } from '../src/rpc.mjs';
import { EventEmitter } from 'node:events';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'figma-accounts-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = {
    model_provider: 'custom', model: 'gateway-model',
    model_providers: { custom: { base_url: 'https://gateway.example/v1' } },
    plugins: { 'figma@official': { enabled: true }, 'unrelated@personal': { enabled: true } },
    apps: { [HOSTED_FIGMA]: { enabled: true }, unrelated: { enabled: true } },
    mcp_servers: { figma_a: { url: FIGMA_URL, enabled: true }, figma_b: { url: FIGMA_URL, enabled: false }, github: { url: 'https://other.example/mcp', enabled: true } }
  };
  let version = 1;
  const calls = [];
  const rpcFactory = () => ({ closed: false, async start() { return this; }, close() { this.closed = true; },
    async request(method, p) {
      calls.push({ method, p: structuredClone(p) });
      if (method === 'config/read') return { config: structuredClone(c), origins: {}, layers: [{ name: { type: 'user', file: join(dir, 'config.toml'), profile: null }, version: String(version), config: structuredClone(c) }] };
      if (method === 'config/batchWrite') {
        if (options.conflict || p.expectedVersion !== String(version)) throw new Error('Configuration version conflict');
        for (const e of p.edits) { const parts = e.keyPath.split('.'); let node = c; for (const part of parts.slice(0, -1)) node = node[part] ||= {}; node[parts.at(-1)] = structuredClone(e.value); }
        version++; return { version: String(version), status: 'ok', overriddenMetadata: null };
      }
      if (method === 'thread/start') return { thread: { id: 'ephemeral-test' } };
      if (method === 'mcpServerStatus/list') return options.inventory === undefined
        ? { data: [{ name: options.alias || 'figma_b', authStatus: options.loggedIn === false ? 'notLoggedIn' : 'oAuth', tools: { whoami: {}, get_screenshot: {} } }] }
        : structuredClone(options.inventory);
      if (method === 'mcpServer/tool/call') return options.toolResult === undefined
        ? { content: [{ type: 'text', text: JSON.stringify({ email: options.email || 'b@example.com', handle: 'b', plans: [] }) }] }
        : structuredClone(options.toolResult);
      throw new Error('Unexpected method ' + method);
    }
  });
  const manager = await new AccountManager({ dir, rpcFactory }).init();
  t.after(() => manager.close());
  manager.db.accounts = {
    figma_a: { label: '工作', identity: { email: 'a@example.com' }, authState: 'verified' },
    figma_b: { label: '个人', identity: { email: 'b@example.com' }, authState: 'verified' }
  };
  return { manager, c, calls, dir };
}

function oauthFixture(manager, calls, options) {
  const base = manager.rpcFactory; let oauth;
  manager.browserOpen = async () => {};
  manager.rpcFactory = opts => {
    const rpc = base(opts); const client = Object.assign(new EventEmitter(), rpc);
    client.request = async (method, p) => {
      if (method === 'mcpServer/oauth/login') {
        calls.push({ method, p: structuredClone(p) }); oauth = { client, alias: p.name };
        return { authorizationUrl: 'https://www.figma.com/oauth?state=test' };
      }
      return rpc.request(method, p);
    };
    return client;
  };
  return {
    complete({ success = true, email } = {}) {
      assert.ok(oauth, 'OAuth must start before completion');
      if (email) options.email = email;
      options.loggedIn = success;
      oauth.client.emit('mcpServer/oauthLogin/completed', { name: oauth.alias, success, error: success ? undefined : '授权未完成。' });
    }
  };
}
async function waitForJob(manager, id, state) {
  for (let i = 0; i < 200 && manager.jobs.get(id).state !== state; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(manager.jobs.get(id).state, state);
  await manager.queue;
  return manager.jobs.get(id);
}

test('switch isolates Figma connections while preserving gateway, other MCPs, and plugins', async t => {
  const { manager, c } = await fixture(t); const provider = structuredClone(c.model_providers);
  await assert.rejects(manager.select('figma_b'), e => e.code === 'HOSTED_CONFLICT');
  assert.equal(c.mcp_servers.figma_a.enabled, true);
  await manager.select('figma_b', true);
  assert.equal(c.mcp_servers.figma_a.enabled, false); assert.equal(c.mcp_servers.figma_b.enabled, true);
  assert.equal(c.apps[HOSTED_FIGMA].enabled, false); assert.equal(c.mcp_servers.github.enabled, true);
  assert.equal(c.plugins['figma@official'].enabled, true); assert.deepEqual(c.model_providers, provider); assert.equal(c.model_provider, 'custom');
  await manager.restore(); assert.equal(c.mcp_servers.figma_a.enabled, true); assert.equal(c.mcp_servers.figma_b.enabled, false); assert.equal(c.apps[HOSTED_FIGMA].enabled, true);
});
test('restore refuses to overwrite subsequent user changes', async t => {
  const { manager, c } = await fixture(t); await manager.select('figma_b', true); c.mcp_servers.figma_a.enabled = true;
  await assert.rejects(manager.restore(), e => e.code === 'RESTORE_CONFLICT'); assert.equal(c.mcp_servers.figma_a.enabled, true);
});
test('configuration version conflict does not switch or claim success', async t => {
  const { manager, c } = await fixture(t, { conflict: true });
  await assert.rejects(manager.select('figma_b', true), /version conflict/); assert.equal(c.mcp_servers.figma_a.enabled, true);
  assert.equal((await manager.status()).canRestore, false);
});
test('use verifies unknown or stale accounts and switches without a separate verification step', async t => {
  for (const authState of ['unknown', 'needs_check']) {
    const { manager, c, calls } = await fixture(t);
    c.apps[HOSTED_FIGMA].enabled = false;
    manager.db.accounts.figma_b.authState = authState;
    manager.db.accounts.figma_b.lastError = 'Old verification failure';
    if (authState === 'unknown') delete manager.db.accounts.figma_b.identity;
    const result = await manager.action('use', { alias: 'figma_b' });
    assert.equal(result.needsNewTask, true);
    assert.equal(c.mcp_servers.figma_b.enabled, true);
    assert.equal(c.mcp_servers.figma_a.enabled, false);
    assert.equal(manager.db.accounts.figma_b.authState, 'verified');
    assert.equal(manager.db.accounts.figma_b.lastError, null);
    assert.equal(calls.filter(c => c.method === 'mcpServer/tool/call').length, 1);
    assert.equal(calls.some(c => c.method === 'mcpServer/oauth/login' || c.method.startsWith('turn/')), false);
  }
});
test('using the already-configured account verifies it without changing config or the restore journal', async t => {
  const { manager, c, calls, dir } = await fixture(t, { alias: 'figma_a', email: 'a@example.com' });
  c.apps[HOSTED_FIGMA].enabled = false;
  const journal = { phase: 'applied', target: 'figma_a', at: '2026-10-28T00:00:00.000Z', changes: [
    { keyPath: 'mcp_servers.figma_b.enabled', before: true, after: false }
  ] };
  manager.db.lastSwitch = structuredClone(journal);
  const result = await manager.use('figma_a');
  assert.equal(result.needsNewTask, true);
  assert.equal(calls.some(c => c.method === 'config/batchWrite'), false);
  assert.equal(calls.filter(c => c.method === 'mcpServer/tool/call').length, 1);
  assert.deepEqual(manager.db.lastSwitch, journal);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).lastSwitch, journal);
});
test('expired authorization opens OAuth and selects the account only after completion', async t => {
  const options = { loggedIn: false }; const { manager, c, calls } = await fixture(t, options);
  c.apps[HOSTED_FIGMA].enabled = false;
  const oauth = oauthFixture(manager, calls, options);
  const started = await manager.use('figma_b');
  assert.equal(started.selectAfterLogin, true);
  await waitForJob(manager, started.id, 'awaiting_user');
  assert.equal((await manager.status()).jobs[0].selectAfterLogin, true);
  assert.equal(c.mcp_servers.figma_a.enabled, true);
  assert.equal(c.mcp_servers.figma_b.enabled, false);
  await assert.rejects(manager.use('figma_a'), e => e.code === 'BUSY');
  await assert.rejects(manager.restore(), e => e.code === 'BUSY');
  oauth.complete();
  const finished = await waitForJob(manager, started.id, 'complete');
  assert.equal(finished.result.needsNewTask, true);
  assert.equal(c.mcp_servers.figma_a.enabled, false);
  assert.equal(c.mcp_servers.figma_b.enabled, true);
  assert.equal(manager.db.lastSwitch.phase, 'applied');
  assert.equal(calls.filter(c => c.method === 'mcpServer/oauth/login').length, 1);
  assert.equal(calls.some(c => c.method.startsWith('turn/')), false);
});
test('cancelled authorization ignores a late completion and leaves the chosen connection unchanged', async t => {
  const options = { loggedIn: false }; const { manager, c, calls } = await fixture(t, options);
  c.apps[HOSTED_FIGMA].enabled = false;
  const oauth = oauthFixture(manager, calls, options);
  const { id } = await manager.use('figma_b');
  await waitForJob(manager, id, 'awaiting_user');
  manager.cancel(id); oauth.complete();
  await new Promise(resolve => setImmediate(resolve));
  await waitForJob(manager, id, 'cancelled');
  assert.equal(c.mcp_servers.figma_a.enabled, true);
  assert.equal(c.mcp_servers.figma_b.enabled, false);
  assert.equal(calls.some(c => c.method === 'config/batchWrite'), false);
});
test('wrong OAuth identity fails once and a later explicit use can authorize the original account', async t => {
  const options = { loggedIn: false }; const { manager, c, calls, dir } = await fixture(t, options);
  c.apps[HOSTED_FIGMA].enabled = false;
  const oauth = oauthFixture(manager, calls, options);
  const first = await manager.use('figma_b');
  await waitForJob(manager, first.id, 'awaiting_user');
  oauth.complete({ email: 'wrong@example.com' });
  await waitForJob(manager, first.id, 'failed');
  assert.equal(c.mcp_servers.figma_a.enabled, true);
  assert.equal(c.mcp_servers.figma_b.enabled, false);
  assert.equal(manager.db.accounts.figma_b.identity.email, 'b@example.com');
  assert.equal(manager.db.accounts.figma_b.lastErrorCode, 'IDENTITY_MISMATCH');
  assert.equal(JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).accounts.figma_b.lastErrorCode, 'IDENTITY_MISMATCH');
  assert.equal(calls.filter(c => c.method === 'mcpServer/oauth/login').length, 1);
  const second = await manager.use('figma_b');
  await waitForJob(manager, second.id, 'awaiting_user');
  assert.equal(calls.filter(c => c.method === 'mcpServer/oauth/login').length, 2);
  oauth.complete({ email: 'b@example.com' });
  await waitForJob(manager, second.id, 'complete');
  assert.equal(c.mcp_servers.figma_b.enabled, true);
  assert.equal(manager.db.accounts.figma_b.lastErrorCode, null);
});
test('an initial wrong identity does not silently reopen OAuth', async t => {
  const options = { email: 'wrong@example.com' }; const { manager, c, calls } = await fixture(t, options);
  c.apps[HOSTED_FIGMA].enabled = false;
  oauthFixture(manager, calls, options);
  await assert.rejects(manager.use('figma_b'), e => e.code === 'IDENTITY_MISMATCH');
  assert.equal(c.mcp_servers.figma_a.enabled, true);
  assert.equal(c.mcp_servers.figma_b.enabled, false);
  assert.equal(calls.some(c => c.method === 'mcpServer/oauth/login'), false);
});
test('use keeps hosted-connector approval ahead of verification or authorization', async t => {
  const options = { loggedIn: false }; const { manager, c, calls } = await fixture(t, options);
  manager.db.accounts.figma_b.lastErrorCode = 'IDENTITY_MISMATCH';
  oauthFixture(manager, calls, options);
  await assert.rejects(manager.use('figma_b'), e => e.code === 'HOSTED_CONFLICT');
  assert.equal(c.apps[HOSTED_FIGMA].enabled, true);
  assert.equal(c.mcp_servers.figma_a.enabled, true);
  assert.equal(calls.some(c => c.method === 'mcpServer/tool/call' || c.method === 'mcpServer/oauth/login' || c.method === 'config/batchWrite'), false);
});
test('connection, tool, and identity-format errors do not start OAuth', async t => {
  for (const options of [
    { inventory: { data: [] }, expected: 'CONNECTION_UNAVAILABLE' },
    { inventory: { data: [{ name: 'figma_b', authStatus: 'oAuth', tools: {} }] }, expected: 'CONNECTION_UNAVAILABLE' },
    { toolResult: { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded' }] }, expected: 'IDENTITY_CHECK_FAILED' },
    { toolResult: { structuredContent: { instructions: {} }, content: [] }, expected: 'IDENTITY_UNAVAILABLE' }
  ]) {
    const { manager, c, calls } = await fixture(t, options);
    c.apps[HOSTED_FIGMA].enabled = false; oauthFixture(manager, calls, options);
    await assert.rejects(manager.use('figma_b'), e => e.code === options.expected);
    assert.equal(calls.some(c => c.method === 'mcpServer/oauth/login' || c.method === 'config/batchWrite'), false);
    assert.equal(c.mcp_servers.figma_a.enabled, true);
  }
});
test('authorization failure or a configuration conflict after OAuth never selects the account', async t => {
  for (const failure of ['authorization', 'timeout', 'configuration']) {
    const options = { loggedIn: false }; const { manager, c, calls } = await fixture(t, options);
    c.apps[HOSTED_FIGMA].enabled = false;
    const oauth = oauthFixture(manager, calls, options);
    const { id } = await manager.use('figma_b');
    await waitForJob(manager, id, 'awaiting_user');
    if (failure === 'authorization') oauth.complete({ success: false });
    else if (failure === 'timeout') manager.jobs.get(id).reject(new Error('授权已超时，请重新开始。'));
    else { options.conflict = true; oauth.complete(); }
    await waitForJob(manager, id, 'failed');
    assert.equal(c.mcp_servers.figma_a.enabled, true);
    assert.equal(c.mcp_servers.figma_b.enabled, false);
  }
});
test('new accounts are disabled and rename leaves their immutable alias intact', async t => {
  const options = {}; const { manager, c } = await fixture(t, options); const { alias } = await manager.add('客户账号');
  assert.match(alias, /^figma_account_[a-f0-9]{12}$/); assert.deepEqual(c.mcp_servers[alias], { url: FIGMA_URL, enabled: false });
  await manager.rename(alias, '新名字'); assert.equal(manager.db.accounts[alias].label, '新名字');
  options.alias = alias; options.loggedIn = false;
  await assert.rejects(manager.select(alias, true), e => e.code === 'AUTH_REQUIRED');
});
test('verification uses an isolated ephemeral context and never starts an AI turn', async t => {
  const { manager, calls, c } = await fixture(t); const r = await manager.verify('figma_b');
  assert.equal(r.identity.email, 'b@example.com');
  const start = calls.find(c => c.method === 'thread/start').p;
  assert.equal(start.ephemeral, true); assert.equal(start.config['mcp_servers.figma_a.enabled'], false);
  assert.equal(start.config['mcp_servers.figma_b.enabled'], true); assert.equal(start.config['mcp_servers.github.enabled'], false);
  assert.equal(start.config.plugins['figma@official'].enabled, false);
  assert.equal(c.mcp_servers.figma_a.enabled, true);
  assert.equal(calls.some(c => c.method.startsWith('turn/')), false);
});
test('verification accepts the Figma whoami envelope and persists a cleared error', async t => {
  const whoami = { user_id: 'figma-b', email: 'b@example.com', handle: 'b', code_layers_enabled: true,
    plans: [{ name: 'Team B', seat: 'Full', type: 'organization' }] };
  const envelope = { whoami, instructions: 'Use this account for Figma operations.' };
  const { manager, calls, dir } = await fixture(t, { toolResult: {
    structuredContent: envelope, content: [{ type: 'text', text: JSON.stringify(envelope) }]
  } });
  manager.db.accounts.figma_b.authState = 'needs_check';
  manager.db.accounts.figma_b.lastError = '未收到可验证的 Figma 身份，不能将连接标为已验证。';
  const result = await manager.verify('figma_b');
  assert.equal(result.identity.email, 'b@example.com');
  assert.deepEqual(result.identity.plans, whoami.plans);
  const stored = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).accounts.figma_b;
  assert.deepEqual(stored.identity, result.identity);
  assert.equal(stored.authState, 'verified');
  assert.equal(stored.lastError, null);
  assert.equal(calls.some(c => c.method === 'config/batchWrite' || c.method.startsWith('turn/')), false);
});
test('wrong browser identity cannot replace an existing account silently', async t => {
  const { manager } = await fixture(t, { email: 'wrong@example.com' });
  await assert.rejects(manager.verify('figma_b'), e => e.code === 'IDENTITY_MISMATCH');
  assert.equal(manager.db.accounts.figma_b.identity.email, 'b@example.com'); assert.equal(manager.db.accounts.figma_b.authState, 'needs_check');
});
test('a different identity in the Figma whoami envelope cannot replace the original account', async t => {
  const { manager, dir } = await fixture(t, { toolResult: {
    structuredContent: { whoami: { email: 'wrong@example.com', handle: 'wrong', plans: [] }, instructions: 'Account information.' }, content: []
  } });
  await assert.rejects(manager.verify('figma_b'), e => e.code === 'IDENTITY_MISMATCH');
  const stored = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).accounts.figma_b;
  assert.equal(stored.identity.email, 'b@example.com');
  assert.equal(stored.authState, 'needs_check');
  assert.match(stored.lastError, /wrong@example\.com/);
});
test('duplicate identities are explicitly reported', async t => {
  const { manager } = await fixture(t, { email: 'a@example.com' }); delete manager.db.accounts.figma_b.identity;
  const r = await manager.verify('figma_b'); assert.equal(r.duplicateOf, 'figma_a');
});
test('only official Figma entries and hosted Figma enable flags are writable', async t => {
  const { manager } = await fixture(t); const s = await manager.config();
  for (const keyPath of ['model_provider', 'mcp_servers.github.enabled', 'apps.unrelated.enabled']) {
    await assert.rejects(manager.writeConfig(s, [{ keyPath, value: false, mergeStrategy: 'replace' }]), /拒绝/);
  }
});
test('structuredContent accepts the Figma whoami envelope', () => {
  const identity = parseIdentity({ structuredContent: {
    whoami: { user_id: 'figma-user', email: 'b@example.com', handle: 'b', plans: [{ name: 'Team B', seat: 'Full' }] },
    instructions: 'Account information.'
  } });
  assert.equal(identity.email, 'b@example.com');
  assert.equal(identity.handle, 'b');
  assert.equal(identity.plans[0].name, 'Team B');
  assert.ok(Number.isFinite(Date.parse(identity.checkedAt)));
});
test('text JSON accepts the Figma whoami envelope', () => {
  const identity = parseIdentity({ content: [{ type: 'text', text: JSON.stringify({
    whoami: { email: 'b@example.com', handle: 'b', plans: [] }, instructions: 'Account information.'
  }) }] });
  assert.equal(identity.email, 'b@example.com');
  assert.equal(identity.handle, 'b');
});
test('legacy top-level identities remain supported in structuredContent and text JSON', () => {
  const legacy = { email: 'b@example.com', handle: 'b', plans: [] };
  for (const result of [
    { structuredContent: legacy },
    { content: [{ type: 'text', text: JSON.stringify(legacy) }] }
  ]) {
    const identity = parseIdentity(result);
    assert.equal(identity.email, legacy.email);
    assert.equal(identity.handle, legacy.handle);
    assert.deepEqual(identity.plans, legacy.plans);
  }
});
test('identity errors do not fabricate a connected account', () => {
  assert.throws(() => parseIdentity({ isError: true,
    structuredContent: { whoami: { email: 'b@example.com' } }
  }), e => e.code === 'IDENTITY_CHECK_FAILED');
  for (const result of [
    { content: [{ type: 'text', text: 'Logged in' }] },
    { structuredContent: { whoami: { email: 'not-an-email' } } },
    { structuredContent: { whoami: null } },
    { structuredContent: { instructions: { email: 'b@example.com' } } }
  ]) assert.throws(() => parseIdentity(result), e => e.code === 'IDENTITY_UNAVAILABLE');
});
test('avatar binds to verified email, survives verification and is hidden for another identity', async t => {
  const { manager, calls } = await fixture(t);
  let downloads = 0;
  manager.avatarDownload = async () => { downloads++; return { dataUrl: 'data:image/png;base64,test', sourceUrl: 'https://s3-alpha.figma.com/profile/test' }; };
  await assert.rejects(manager.importAvatar('figma_b', 'a@example.com', 'test'), e => e.code === 'IDENTITY_MISMATCH');
  assert.equal(downloads, 0);
  await manager.importAvatar('figma_b', 'B@example.com', 'test');
  await manager.rename('figma_b', '个人 Figma');
  await manager.verify('figma_b');
  let row = (await manager.status()).accounts.find(a => a.alias === 'figma_b');
  assert.equal(row.avatar.dataUrl, 'data:image/png;base64,test');
  assert.equal(calls.some(c => c.method === 'config/batchWrite' || c.method.startsWith('turn/')), false);
  manager.db.accounts.figma_b.identity.email = 'other@example.com';
  row = (await manager.status()).accounts.find(a => a.alias === 'figma_b');
  assert.equal(row.avatar, null);
});
test('adapter hard blocks inference methods even if accidentally called', async () => {
  const rpc = new CodexRpc();
  await assert.rejects(rpc.request('turn/start', {}), /禁止调用模型/);
  await assert.rejects(rpc.request('mcpServer/tool/call', { tool: 'use_figma' }), /只允许/);
});
test('reauthorizing the wrong person disables the already-active alias', async t => {
  const { manager, c } = await fixture(t, { alias: 'figma_a', email: 'wrong@example.com' });
  const base = manager.rpcFactory;
  manager.browserOpen = async () => {};
  manager.rpcFactory = opts => {
    const rpc = base(opts); const client = Object.assign(new EventEmitter(), rpc);
    client.request = async (method, p) => {
      if (method === 'mcpServer/oauth/login') {
        setTimeout(() => client.emit('mcpServer/oauthLogin/completed', { name: p.name, success: true }), 5);
        return { authorizationUrl: 'https://www.figma.com/oauth?state=test' };
      }
      return rpc.request(method, p);
    };
    return client;
  };
  const { id } = await manager.login('figma_a');
  for (let i = 0; i < 100 && !['failed', 'complete'].includes(manager.jobs.get(id).state); i++) await new Promise(resolve => setTimeout(resolve, 5));
  // The failure state is set before its protective config mutation completes.
  await manager.queue;
  assert.equal(manager.jobs.get(id).state, 'failed');
  assert.equal(c.mcp_servers.figma_a.enabled, false);
  assert.equal(manager.db.accounts.figma_a.identity.email, 'a@example.com');
  assert.match(manager.jobs.get(id).error, /已停用/);
  manager.close();
});
