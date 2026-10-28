import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

// Run the embedded UI in an isolated mock host. Never connect to account services.
function embeddedPanel({ reducedMotion = false } = {}) {
  const elements = new Map(), variables = new Map(), events = new Map(), outbound = [], timers = new Map(), animations = [], clipboardWrites = [];
  let timerId = 1, document;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.dataset = {}; this.children = []; this._text = '';
      this.value = ''; this.hidden = false; this.open = false; this.disabled = false;
      this.parentNode = null; this.listeners = new Map(); this.attributes = new Map(); this.classes = new Set();
      this.classList = {
        add: (...values) => values.forEach(value => this.classes.add(value)),
        remove: (...values) => values.forEach(value => this.classes.delete(value)),
        contains: value => this.classes.has(value),
        toggle: (value, enabled = !this.classes.has(value)) => { enabled ? this.classes.add(value) : this.classes.delete(value); return enabled; }
      };
      this.style = { setProperty() {}, removeProperty() {} };
    }
    get className() { return [...this.classes].join(' '); }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.firstChild; }
    get parentElement() { return this.parentNode; }
    get isConnected() { return !!this.parentNode; }
    append(...children) { for (const child of children) this.insertBefore(child, null); }
    insertBefore(child, reference) {
      if (child === reference) return child;
      child.remove?.();
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      assert.ok(index >= 0, 'insertBefore reference must belong to parent');
      this.children.splice(index, 0, child); child.parentNode = this;
      return child;
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parentNode = null;
      this.children = []; this._text = ''; this.append(...children);
    }
    replaceWith(child) { const parent = this.parentNode; if (parent) { parent.insertBefore(child, this); this.remove(); } }
    remove() {
      if (this.parentNode) {
        if (this.contains(document.activeElement)) document.activeElement = null;
        const parent = this.parentNode; parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null;
      }
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    dispatch(type) { for (const listener of this.listeners.get(type) || []) listener({ preventDefault() {}, target: this }); }
    click() { if (!this.disabled && !this.hidden) this.dispatch('click'); }
    focus() { document.activeElement = this; }
    contains(element) { return element === this || this.children.some(child => child.contains?.(element)); }
    matches(selector) { return selector.startsWith('.') ? this.classes.has(selector.slice(1)) : this.tagName.toLowerCase() === selector; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches?.(selector) ? [child] : []), ...(child.querySelectorAll?.(selector) || [])]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() { const index = this.parentNode?.children.indexOf(this) || 0; return { top: index * 100, left: 0, width: 600, height: 100 }; }
    animate(keyframes, options) {
      const animation = { finished: Promise.resolve(), cancelled: false, cancel() { this.cancelled = true; }, playState: 'running' };
      animations.push({ element: this, keyframes, options, animation }); return animation;
    }
    getAnimations() { return []; }
    showModal() { this.open = true; } close() { this.open = false; }
  }
  const root = new Element('html');
  root.style = { setProperty: (name, value) => variables.set(name, value), removeProperty: name => variables.delete(name) };
  document = {
    documentElement: root, activeElement: null,
    querySelector: selector => {
      const [base, descendant] = selector.split(' ');
      if (!elements.has(base)) elements.set(base, new Element());
      return descendant ? elements.get(base).querySelector(descendant) : elements.get(base);
    },
    querySelectorAll: selector => selector === '.content button' ? [...elements.values()].flatMap(element => element.querySelectorAll('button')) : [],
    createElement: tag => new Element(tag), createTextNode: value => ({ textContent: String(value) })
  };
  const parent = { postMessage: message => outbound.push(message) };
  const window = {
    FIGMA_ACCOUNTS_EMBEDDED: true, parent, addEventListener: (event, listener) => events.set(event, listener),
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {} })
  };
  runInNewContext(app, {
    window, document, location: { hash: '', pathname: '/' }, URLSearchParams,
    navigator: { clipboard: { writeText: async value => { clipboardWrites.push(value); } } },
    fetch: () => { throw new Error('Embedded tests must not use HTTP or account services.'); },
    setTimeout: callback => { const id = timerId++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: callback => callback()
  });
  function message(data, source = parent) { events.get('message')({ source, data: { jsonrpc: '2.0', ...data } }); }
  function contextChanged(params, source = parent) { message({ method: 'ui/notifications/host-context-changed', params }, source); }
  function update(snapshot) { message({ method: 'ui/notifications/tool-result', params: { structuredContent: { snapshot } } }); }
  async function initialize(hostContext) {
    const request = outbound[0];
    assert.equal(request.method, 'ui/initialize');
    assert.equal(request.params.protocolVersion, '2026-01-26');
    assert.deepEqual(Array.from(request.params.appCapabilities.availableDisplayModes || []), ['inline', 'fullscreen']);
    message({ id: request.id, result: { protocolVersion: '2026-01-26', hostContext } });
    await flush();
    assert.ok(outbound.some(item => item.method === 'ui/notifications/initialized'));
    const status = outbound.find(item => item.method === 'tools/call');
    assert.equal(status.params.name, 'list_accounts');
    message({ id: status.id, result: { structuredContent: { snapshot: accountSnapshot([]) } } });
    await flush();
    assert.equal(elements.get('#account-count').textContent, '0 个账号');
  }
  return { root, variables, outbound, contextChanged, initialize, update, animations, elements, document, clipboardWrites,
    reply: (id, result) => message({ id, result }),
    rows: () => elements.get('#accounts').children.filter(element => element.tagName === 'ARTICLE') };
}

function accountSnapshot(accounts, overrides = {}) {
  return { accounts, jobs: [], hosted: { enabled: false }, provider: { name: 'mock' }, pendingDesktop: null, canRestore: false, ...overrides };
}
function account(alias, enabled = false, overrides = {}) {
  return { alias, label: alias + ' account', enabled, authState: 'verified',
    identity: { email: alias + '@example.com', handle: alias, plans: [{ seat: 'Full' }] }, ...overrides };
}

test('embedded initialization applies the host theme, display mode and standard styles before showing account data', async () => {
  const panel = embeddedPanel();
  await panel.initialize({ theme: 'dark', displayMode: 'inline', styles: { variables: {
    '--color-background-primary': '#202020', '--color-text-primary': '#ededed',
    '--font-sans': 'Host Sans', '--font-text-sm-size': '14px',
    '--font-text-sm-line-height': '20px', '--border-radius-lg': '12px'
  } } });
  assert.ok(panel.root.classList.contains('embedded'));
  assert.equal(panel.root.dataset.theme, 'dark');
  assert.equal(panel.root.dataset.displayMode, 'inline');
  assert.equal(panel.variables.get('--color-background-primary'), '#202020');
  assert.equal(panel.variables.get('--color-text-primary'), '#ededed');
  assert.equal(panel.variables.get('--font-sans'), 'Host Sans');
  assert.equal(panel.variables.get('--font-text-sm-size'), '14px');
  assert.equal(panel.variables.get('--font-text-sm-line-height'), '20px');
  assert.equal(panel.variables.get('--border-radius-lg'), '12px');
  assert.deepEqual(panel.outbound.filter(item => item.method === 'tools/call').map(item => item.params.name), ['list_accounts']);
});

test('host context notifications merge partial updates while preserving unrelated theme values', async () => {
  const panel = embeddedPanel();
  await panel.initialize({ theme: 'dark', displayMode: 'inline', styles: { variables: {
    '--color-text-primary': '#ededed', '--font-sans': 'Host Sans', '--border-radius-lg': '12px'
  } } });
  panel.contextChanged({ theme: 'light' });
  assert.equal(panel.root.dataset.theme, 'light');
  assert.equal(panel.root.dataset.displayMode, 'inline');
  assert.equal(panel.variables.get('--color-text-primary'), '#ededed');
  assert.equal(panel.variables.get('--font-sans'), 'Host Sans');
  panel.contextChanged({ displayMode: 'fullscreen', styles: { variables: { '--color-text-primary': '#232323' } } });
  assert.equal(panel.root.dataset.theme, 'light');
  assert.equal(panel.root.dataset.displayMode, 'fullscreen');
  assert.equal(panel.variables.get('--color-text-primary'), '#232323');
  assert.equal(panel.variables.get('--font-sans'), 'Host Sans');
  assert.equal(panel.variables.get('--border-radius-lg'), '12px');
});

test('host theme updates reject foreign messages, unsupported modes and invalid style values', async () => {
  const panel = embeddedPanel();
  await panel.initialize({ theme: 'dark', displayMode: 'inline', styles: { variables: { '--color-text-primary': '#ededed' } } });
  panel.contextChanged({ theme: 'light', styles: { variables: { '--color-text-primary': '#000' } } }, {});
  assert.equal(panel.root.dataset.theme, 'dark');
  assert.equal(panel.variables.get('--color-text-primary'), '#ededed');
  panel.contextChanged({ theme: 'invalid', displayMode: 'pip', styles: { variables: {
    color: 'red', '--application-secret': 'value', '--font-sans': 23, '--color-background-primary': null,
    '--border-radius-lg': {}, '--color-text-primary;opacity': '0', '--color-text-secondary': '#b0b0b0'
  } } });
  assert.equal(panel.root.dataset.theme, 'dark');
  assert.equal(panel.root.dataset.displayMode, 'inline');
  assert.deepEqual([...panel.variables], [['--color-text-primary', '#ededed'], ['--color-text-secondary', '#b0b0b0']]);
});


test('account order remains deterministic when host snapshots arrive in different orders', async () => {
  const panel = embeddedPanel(); await panel.initialize({ theme: 'light' });
  const accounts = [account('z-active', true), account('b-second'), account('a-first')];
  panel.update(accountSnapshot([accounts[1], accounts[0], accounts[2]]));
  assert.deepEqual(panel.rows().map(row => row.dataset.alias), ['z-active', 'a-first', 'b-second']);
  for (const shuffled of [[accounts[2], accounts[1], accounts[0]], [accounts[0], accounts[2], accounts[1]]]) {
    panel.update(accountSnapshot(shuffled));
    assert.deepEqual(panel.rows().map(row => row.dataset.alias), ['z-active', 'a-first', 'b-second']);
  }
  // A separately mounted panel makes the same choice, independent of first snapshot order.
  const remounted = embeddedPanel(); await remounted.initialize({ theme: 'light' });
  remounted.update(accountSnapshot([accounts[2], accounts[1], accounts[0]]));
  assert.deepEqual(remounted.rows().map(row => row.dataset.alias), ['z-active', 'a-first', 'b-second']);
});

test('switching the configured connection pins it and preserves reusable controls', async () => {
  const panel = embeddedPanel(); await panel.initialize({ theme: 'light' });
  panel.update(accountSnapshot([account('a-old', true), account('z-new')]));
  const [oldRow, newRow] = panel.rows(); const newButton = newRow.querySelectorAll('button').at(-1);
  assert.equal(oldRow.querySelectorAll('button').at(-1).hidden, true);
  assert.equal(newButton.hidden, false);
  newButton.focus();
  panel.update(accountSnapshot([account('a-old'), account('z-new', true)]));
  assert.deepEqual(panel.rows().map(row => row.dataset.alias), ['z-new', 'a-old']);
  assert.equal(panel.rows()[0], newRow); assert.equal(panel.rows()[1], oldRow);
  assert.equal(newRow.querySelectorAll('button').at(-1), newButton);
  assert.equal(newButton.hidden, true);
  assert.equal(oldRow.querySelectorAll('button').at(-1).hidden, false);
  assert.equal(panel.document.activeElement, newRow.querySelectorAll('button')[0]);
  assert.equal(newRow.querySelector('.tag').textContent, '当前 MCP 连接');
  assert.equal(oldRow.querySelector('.tag')?.hidden ?? true, true);
});

test('unchanged and permuted refreshes preserve rows and do not replay account motion', async () => {
  const panel = embeddedPanel(); await panel.initialize({ theme: 'dark' });
  const a = account('z-active', true), b = account('a-other');
  panel.update(accountSnapshot([a, b]));
  const rows = [...panel.rows()], buttons = rows.map(row => row.querySelectorAll('button').at(-1));
  const motionCount = panel.animations.filter(entry => entry.element.tagName === 'ARTICLE').length;
  panel.update(accountSnapshot([b, a])); panel.update(accountSnapshot([a, b]));
  panel.update(accountSnapshot([{ ...a, identity: { ...a.identity, checkedAt: '2026-10-28T08:00:00Z' } }, b]));
  assert.deepEqual(panel.rows(), rows);
  assert.deepEqual(panel.rows().map(row => row.querySelectorAll('button').at(-1)), buttons);
  assert.equal(panel.animations.filter(entry => entry.element.tagName === 'ARTICLE').length, motionCount);
  assert.ok(panel.animations.filter(entry => entry.element.tagName === 'ARTICLE').every(entry => !entry.animation.cancelled));
});

test('retained account controls display and act on the latest label and avatar data', async () => {
  const panel = embeddedPanel(); await panel.initialize({ theme: 'light' });
  const original = account('a-account', false, { label: 'Original label' });
  panel.update(accountSnapshot([original]));
  const row = panel.rows()[0], [renameButton, useButton] = row.querySelectorAll('button');
  const revised = { ...original, label: 'Revised label', avatar: { dataUrl: 'data:image/png;base64,AAAA' } };
  panel.update(accountSnapshot([revised]));
  assert.equal(panel.rows()[0], row);
  assert.ok(row.textContent.includes('Revised label'));
  assert.ok(!row.textContent.includes('Original label'));
  assert.equal(row.querySelector('.avatar').querySelector('img').src, revised.avatar.dataUrl);
  renameButton.click();
  assert.equal(panel.elements.get('#account-label').value, 'Revised label');
  panel.elements.get('#account-dialog').close();
  useButton.click();
  assert.ok(panel.elements.get('#command').textContent.includes('Revised label'));
  const request = panel.outbound.at(-1);
  assert.equal(request.params.name, 'manage_account');
  assert.equal(request.params.arguments.action, 'use');
  assert.equal(request.params.arguments.data.alias, 'a-account');
});

test('conflicting enabled connections do not claim one current MCP account', async () => {
  const panel = embeddedPanel(); await panel.initialize({ theme: 'light' });
  panel.update(accountSnapshot([account('b', true), account('a', true), account('c')]));
  assert.deepEqual(panel.rows().map(row => row.dataset.alias), ['a', 'b', 'c']);
  for (const row of panel.rows()) assert.notEqual(row.querySelector('.tag')?.textContent, '当前 MCP 连接');
  assert.ok(panel.elements.get('#connection-status').textContent.includes('多个账号连接同时启用'));
  panel.update(accountSnapshot([account('a', true)], { hosted: { enabled: true } }));
  assert.equal(panel.rows()[0].querySelector('.tag').textContent, '已启用');
  assert.equal(panel.elements.get('#hosted-notice').hidden, false);
  const action = panel.rows()[0].querySelectorAll('button').at(-1);
  assert.equal(action.hidden, false); assert.equal(action.textContent, '使用此账号');
  panel.update(accountSnapshot([account('a', true, { authState: 'needs_check' })]));
  assert.equal(action.hidden, false); assert.equal(action.textContent, '检查连接');
  panel.update(accountSnapshot([account('a', true, { authState: 'needs_check', lastError: '授权已失效' })]));
  assert.equal(action.hidden, false); assert.equal(action.textContent, '修复连接');
  panel.update(accountSnapshot([account('a', true)]));
  assert.equal(action.hidden, true);
});

test('reduced motion keeps account ordering immediate without account animations', async () => {
  const panel = embeddedPanel({ reducedMotion: true }); await panel.initialize({ theme: 'light' });
  panel.update(accountSnapshot([account('a', true), account('b')]));
  panel.update(accountSnapshot([account('a'), account('b', true)]));
  assert.deepEqual(panel.rows().map(row => row.dataset.alias), ['b', 'a']);
  assert.equal(panel.animations.filter(entry => entry.element.tagName === 'ARTICLE').length, 0);
});

test('connection success offers the exact verification target and hides it when the connection changes', async () => {
  const panel = embeddedPanel(); await panel.initialize({ theme: 'light' });
  panel.update(accountSnapshot([account('current'), account('other', true)], { pendingDesktop: { alias: 'old-journal-target' } }));
  panel.rows()[1].querySelectorAll('button').at(-1).click();
  const request = panel.outbound.at(-1);
  const s = accountSnapshot([account('current', true), account('other')]);
  panel.reply(request.id, { structuredContent: { result: { needsNewTask: true, message: '账号连接已配置。' }, snapshot: s } });
  await flush();
  const copy = panel.elements.get('#copy-check');
  assert.equal(copy.hidden, false); assert.equal(copy.dataset.alias, 'current');
  assert.equal(panel.elements.has('#desktop-notice'), false);
  panel.update(accountSnapshot([account('current'), account('other', true)]));
  assert.equal(copy.hidden, true);
});

test('OAuth success preserves green message motion and does not overwrite copied feedback on refresh', async () => {
  for (const reducedMotion of [false, true]) {
    const panel = embeddedPanel({ reducedMotion }); await panel.initialize({ theme: 'light' });
    const s = accountSnapshot([account('selected', true)], { jobs: [{ id: 'completed-login', alias: 'selected', state: 'complete', selectAfterLogin: true, result: { needsNewTask: true, message: '账号连接已配置。' } }] });
    panel.update(s);
    const result = panel.elements.get('#result'), copy = panel.elements.get('#copy-check');
    assert.equal(copy.hidden, false);
    const motions = panel.animations.filter(entry => entry.element === result);
    assert.equal(motions.length, reducedMotion ? 0 : 1);
    if (!reducedMotion) { assert.equal(motions[0].options.duration, 200); assert.equal(motions[0].keyframes[0].transform, 'translateY(3px)'); }
    copy.click(); await flush();
    assert.ok(panel.clipboardWrites[0].includes('「selected」'));
    assert.equal(panel.elements.get('#result-message').textContent, '身份检查指令已复制，请粘贴到 Codex 新任务。');
    const count = panel.animations.length;
    panel.update(s);
    assert.equal(panel.elements.get('#result-message').textContent, '身份检查指令已复制，请粘贴到 Codex 新任务。');
    assert.equal(panel.animations.length, count);
  }
});
