import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Only inspect descriptors and static UI resources. Never start the account service.
const discoveryMethods = new Set(['initialize', 'tools/list', 'resources/list', 'resources/read']);
async function server(t) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/mcp.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map(); let nextId = 1;
  const lines = createInterface({ input: child.stdout });
  const fail = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('MCP discovery process closed.')));
  lines.on('line', line => {
    const message = JSON.parse(line); const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) { const error = new Error(message.error.message); error.code = message.error.code; item.reject(error); }
    else item.resolve(message.result);
  });
  t.after(() => { child.kill('SIGTERM'); lines.close(); fail(new Error('Discovery test completed.')); });
  function request(method, params = {}) {
    assert.ok(discoveryMethods.has(method), 'UI discovery tests must not call account tools.');
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP discovery request timed out: ' + method)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'figma-ui-discovery-test', version: '1.0.0' }
  });
  assert.equal(initialized.serverInfo.name, 'figma-account-switch');
  assert.ok(initialized.capabilities.tools); assert.ok(initialized.capabilities.resources);
  return request;
}

test('account panel exposes global and conversation entrypoints linked to a registered versioned UI resource', async t => {
  const request = await server(t);
  const { tools } = await request('tools/list');
  const panel = tools.find(tool => tool.name === 'open_accounts_panel');
  assert.ok(panel);
  assert.deepEqual(panel._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.match(panel._meta.ui.resourceUri, /\/panel-v\d+\.html$/);
  const { resources } = await request('resources/list');
  const resource = resources.find(item => item.uri === panel._meta.ui.resourceUri);
  assert.ok(resource, 'The UI linked from the tool must be discoverable.');
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  for (const tool of tools.filter(item => item.name !== panel.name)) {
    assert.equal(tool._meta?.ui?.resourceUri, undefined, 'Data tools must update the mounted panel without remounting it.');
  }
  assert.deepEqual(tools.find(tool => tool.name === 'manage_account')._meta.ui.visibility, ['model', 'app']);
});

test('embedded resource is a self-contained MCP App that uses the host bridge instead of localhost requests', async t => {
  const request = await server(t);
  const { tools } = await request('tools/list');
  const uri = tools.find(tool => tool.name === 'open_accounts_panel')._meta.ui.resourceUri;
  const { contents } = await request('resources/read', { uri });
  assert.equal(contents.length, 1);
  const resource = contents[0];
  assert.equal(resource.uri, uri); assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.text, /<!doctype html>/i);
  assert.match(resource.text, /window\.FIGMA_ACCOUNTS_EMBEDDED=true/);
  assert.doesNotMatch(resource.text, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(resource.text, /<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i);
  assert.match(resource.text, /ui\/initialize/);
  assert.match(resource.text, /ui\/notifications\/initialized/);
  assert.match(resource.text, /ui\/notifications\/tool-result/);
  assert.match(resource.text, /bridge\('tools\/call'/);
  const scripts = [...resource.text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  const mainScript = scripts.find(item => item[1].includes("bridge('ui/initialize'"));
  assert.ok(mainScript, 'The bundled account UI script must be present.');
  for (const id of ['accounts', 'add-account']) {
    const elementIndex = resource.text.indexOf('id="' + id + '"');
    assert.ok(elementIndex >= 0 && elementIndex < mainScript.index, 'Interactive DOM must exist before the UI script executes: ' + id);
  }
  assert.ok(mainScript.index + mainScript[0].length <= resource.text.indexOf('</body>'), 'The UI script must execute within the completed body.');
  const head = resource.text.match(/<head>([\s\S]*?)<\/head>/i)?.[1];
  assert.ok(head);
  assert.doesNotMatch(head, /ui\/initialize|\(\(\) => \{/);
  assert.equal(resource._meta.ui.prefersBorder, false);
  assert.deepEqual(resource._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen']);
  assert.deepEqual(resource._meta.ui.csp.connectDomains, []);
  assert.deepEqual(resource._meta.ui.csp.resourceDomains, []);
});

test('unknown UI resource requests fail instead of returning unrelated files', async t => {
  const request = await server(t);
  for (const uri of ['ui://figma-accounts/missing.html', 'file:///etc/passwd']) {
    await assert.rejects(request('resources/read', { uri }), error => error.code === -32603 && /Unknown resource/.test(error.message));
  }
});
