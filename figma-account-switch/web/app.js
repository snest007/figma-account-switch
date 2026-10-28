(() => {
  const $ = selector => document.querySelector(selector);
  const embedded = !!window.FIGMA_ACCOUNTS_EMBEDDED;
  if (embedded) document.documentElement.classList.add('embedded');
  const fragment = new URLSearchParams(location.hash.slice(1));
  let session = fragment.get('session');
  if (!embedded) {
    try { session ||= sessionStorage.getItem('figmaAccountsSession'); if (session) sessionStorage.setItem('figmaAccountsSession', session); } catch {}
    if (session) history.replaceState(null, '', location.pathname);
  }
  let snapshot = null, busy = false, dialogAction = null, pollTimer = null, messageId = 1;
  const requests = new Map();
  const accountRows = new Map();
  let accountsLayoutKey = null;
  let terminalJobKey = null;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  function animate(el, frames, options = {}) {
    if (reducedMotion?.matches || typeof el.animate !== 'function') return null;
    return el.animate(frames, { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)', ...options });
  }
  reducedMotion?.addEventListener?.('change', () => {
    if (reducedMotion.matches) {
      for (const record of accountRows.values()) record.motion?.cancel();
      $('#result').getAnimations?.().forEach(motion => motion.cancel());
    }
  });
  function setText(el, value) { if (el.textContent !== value) el.textContent = value; }
  function applyHostContext(context) {
    if (!context || typeof context !== 'object') return;
    const root = document.documentElement;
    if (context.theme === 'light' || context.theme === 'dark') root.dataset.theme = context.theme;
    if (context.displayMode === 'inline' || context.displayMode === 'fullscreen') root.dataset.displayMode = context.displayMode;
    const variables = context.styles?.variables;
    if (!variables || typeof variables !== 'object') return;
    for (const [name, value] of Object.entries(variables)) {
      if (!/^--(?:color|font|border-radius|spacing)-[a-z0-9-]+$/.test(name) || typeof value !== 'string') continue;
      root.style.setProperty(name, value);
    }
  }
  function text(tag, value, className) { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; }
  function accountAvatar(account) {
    const name = account.identity?.handle?.trim() || account.label;
    const initial = Array.from(name)[0] || '';
    const avatar = text('div', initial, 'avatar');
    const dataUrl = account.avatar?.dataUrl;
    if (typeof dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) return avatar;
    const image = document.createElement('img');
    image.alt = name + '的头像';
    image.addEventListener('error', () => {
      avatar.replaceChildren(document.createTextNode(initial));
      avatar.removeAttribute('title');
    }, { once: true });
    image.src = dataUrl;
    avatar.title = 'Figma 头像 · 本地缓存';
    avatar.replaceChildren(image);
    return avatar;
  }
  function button(label, className, handler) { const b = text('button', label, className); b.type = 'button'; b.addEventListener('click', handler); return b; }
  function command(value) { $('#command').textContent = value; }
  function configuredAlias(s = snapshot) {
    const active = (s?.accounts || []).filter(a => a.enabled);
    return active.length === 1 && !s.hosted.enabled ? active[0].alias : null;
  }
  function result(value, error = false, verificationAlias = null) {
    const el = $('#result'), message = $('#result-message'), copy = $('#copy-check');
    const showCopy = !!value && !error && !!verificationAlias && verificationAlias === configuredAlias();
    const changed = el.hidden || message.textContent !== (value || '') || el.classList.contains('error') !== error || copy.hidden === showCopy;
    el.hidden = !value; setText(message, value || ''); el.classList.toggle('error', error);
    copy.hidden = !showCopy; copy.dataset.alias = showCopy ? verificationAlias : '';
    if (value && changed) {
      el.getAnimations?.().forEach(motion => motion.cancel());
      animate(el, [{ opacity: .35, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }]);
    }
  }
  function bridge(method, params) {
    const id = messageId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('面板通信超时，请在本地浏览器面板重试。')); }, 240000);
      requests.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  window.addEventListener('message', event => {
    if (!embedded || event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
    const m = event.data;
    if (m.id !== undefined && requests.has(m.id)) {
      const p = requests.get(m.id); requests.delete(m.id); clearTimeout(p.timer);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'ui/notifications/host-context-changed') applyHostContext(m.params);
    else if (m.method === 'ui/notifications/tool-result' && m.params?.structuredContent?.snapshot) render(m.params.structuredContent.snapshot);
  });
  async function api(action, data = {}) {
    if (embedded) {
      const r = await bridge('tools/call', action === 'status' ? { name: 'list_accounts', arguments: {} } : { name: 'manage_account', arguments: { action, data } });
      if (r.isError) { const e = new Error(r.structuredContent?.error || '操作失败。'); e.code = r.structuredContent?.code; throw e; }
      return action === 'status' ? r.structuredContent.snapshot : r.structuredContent;
    }
    if (!session) throw new Error('请通过 Figma Accounts 插件重新打开面板，以建立本地连接。');
    const response = await fetch(action === 'status' ? '/api/status' : '/api/action', {
      method: action === 'status' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Figma-Accounts-Session': session },
      ...(action === 'status' ? {} : { body: JSON.stringify({ action, data }) })
    });
    const value = await response.json();
    if (!response.ok) { const e = new Error(value.error); e.code = value.code; throw e; }
    return value;
  }
  function setBusy(value) { busy = value; document.querySelectorAll('.content button').forEach(b => b.disabled = value || b.dataset.unavailable === 'true'); $('#dialog-submit').disabled = value; $('#account-form').classList.toggle('busy', value); }
  async function act(action, data, message) {
    if (busy) return;
    setBusy(true); result(message || '正在处理…');
    try {
      const response = await api(action, data);
      if (response.snapshot) render(response.snapshot);
      const output = response.result;
      let summary = output?.message || (output?.selectAfterLogin ? '请在浏览器中完成 Figma 授权，完成后将自动切换账号。' : action === 'login' ? '已开始授权，请在浏览器中选择正确的 Figma 账号。' : '操作已完成。');
      if (output?.identity) summary += '\n' + output.identity.email;
      result(summary, false, output?.needsNewTask ? data.alias : action === 'restore' ? configuredAlias() : null); return output;
    } catch (e) {
      try { render(await api('status')); } catch {}
      result(e.message, true); throw e;
    }
    finally { setBusy(false); }
  }
  function updateAccount(a, applied, authorizing) {
    let record = accountRows.get(a.alias);
    if (!record) {
      const row = text('article', '', 'account'); row.dataset.alias = a.alias;
      const avatar = accountAvatar(a), info = text('div', '', 'account-info');
      const name = text('div', '', 'account-name'), label = text('span', ''), tag = text('span', '', 'tag');
      name.append(label, tag);
      const email = text('div', '', 'email'), meta = text('div', '', 'account-meta'), error = text('div', '', 'account-error');
      info.append(name, email, meta, error);
      const actions = text('div', '', 'account-actions');
      const rename = button('✎', 'icon-button', () => openRename(record.account)); rename.title = '修改名称';
      const select = button('使用此账号', 'button', () => openSwitch(record.account));
      select.title = '自动检查授权，并配置 Codex 后续使用的 Figma 账号';
      actions.append(rename, select); row.append(avatar, info, actions);
      record = { row, avatar, info, label, tag, email, meta, error, rename, select, avatarKey: JSON.stringify([a.label, a.identity?.handle, a.avatar?.dataUrl]) };
      accountRows.set(a.alias, record);
    }
    record.account = a;
    const avatarKey = JSON.stringify([a.label, a.identity?.handle, a.avatar?.dataUrl]);
    if (record.avatarKey !== avatarKey) {
      const avatar = accountAvatar(a);
      record.row.insertBefore(avatar, record.avatar); record.avatar.remove();
      record.avatar = avatar; record.avatarKey = avatarKey;
    }
    setText(record.label, a.label);
    record.tag.hidden = !a.enabled && !!a.identity;
    setText(record.tag, applied ? '当前 MCP 连接' : a.enabled ? '已启用' : '待授权');
    record.tag.classList.toggle('pending-tag', !a.enabled && !a.identity);
    record.tag.title = applied ? '当前配置的 Figma MCP 连接；已打开的 Codex 任务需单独验证实际账号。' : '';
    setText(record.email, a.identity?.email || '完成授权后显示真实邮箱');
    const state = a.authState === 'verified' ? '身份已验证' : a.authState === 'needs_check' ? '需要验证身份' : '身份尚未验证';
    setText(record.meta, state + (a.identity?.plans?.[0]?.seat ? ' · ' + a.identity.plans[0].seat : ''));
    setText(record.error, a.lastError || ''); record.error.hidden = !a.lastError;
    record.rename.setAttribute('aria-label', '修改' + a.label + '的名称');
    record.rename.dataset.unavailable = record.select.dataset.unavailable = String(authorizing);
    const connected = applied && a.authState === 'verified' && !a.lastError;
    record.select.hidden = connected;
    setText(record.select, applied ? (a.lastError ? '修复连接' : '检查连接') : '使用此账号');
    record.select.title = applied ? '检查授权并尝试恢复此账号的 Figma 连接' : '自动检查授权，并配置 Codex 后续使用的 Figma 账号';
    if (connected && !busy && !authorizing && !record.rename.disabled && document.activeElement === record.select) record.rename.focus({ preventScroll: true });
    record.select.classList.toggle('primary', !applied);
    return record;
  }
  function renderAccounts(s, active, authorizing) {
    const container = $('#accounts'), before = new Map();
    let focused = document.activeElement;
    // RPC object order can change after config writes. The immutable alias keeps ties stable.
    const ordered = [...s.accounts].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
    const layoutKey = JSON.stringify([s.hosted.enabled, ordered.map(a => [a.alias, a.enabled, a.label, a.identity?.email, a.identity?.handle, a.identity?.plans?.[0]?.seat, a.avatar?.dataUrl, a.authState, a.lastError])]);
    const layoutChanged = layoutKey !== accountsLayoutKey;
    const aliases = new Set(s.accounts.map(a => a.alias));
    for (const [alias, record] of accountRows) {
      if (layoutChanged) before.set(alias, record.row.getBoundingClientRect?.());
      if (!aliases.has(alias)) { record.motion?.cancel(); record.row.remove(); accountRows.delete(alias); }
    }
    if (layoutChanged) for (const child of Array.from(container.children)) if (!child.dataset.alias) child.remove();
    accountsLayoutKey = layoutKey;
    if (!ordered.length) {
      if (layoutChanged) {
        const empty = text('div', '', 'empty'); empty.append(text('strong', '连接你的第一个 Figma 账号'), text('p', '每个账号分别授权，选择要让 Codex 使用的账号。'));
        container.append(empty);
      }
      return;
    }
    const records = ordered.map(a => updateAccount(a, a.enabled && active.length === 1 && !s.hosted.enabled, authorizing));
    if (focused?.hidden) focused = document.activeElement;
    if (layoutChanged) for (const record of records) record.motion?.cancel();
    records.forEach((record, i) => {
      if (container.children[i] !== record.row) {
        const next = container.children[i] || null;
        if (typeof container.moveBefore === 'function' && record.row.parentNode === container) container.moveBefore(record.row, next);
        else container.insertBefore(record.row, next);
      }
    });
    if (focused && !focused.hidden && document.activeElement !== focused && container.contains?.(focused)) focused.focus({ preventScroll: true });
    if (!layoutChanged) return;
    // Batch layout reads before starting compositor-only position transitions.
    const after = new Map(records.map(record => [record.row.dataset.alias, record.row.getBoundingClientRect?.()]));
    for (const record of records) {
      const previous = before.get(record.row.dataset.alias), current = after.get(record.row.dataset.alias);
      if (!previous) record.motion = animate(record.row, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }]);
      else if (current && (Math.abs(previous.top - current.top) > .5 || Math.abs(previous.left - current.left) > .5)) {
        record.motion = animate(record.row, [{ transform: 'translate(' + (previous.left - current.left) + 'px,' + (previous.top - current.top) + 'px)' }, { transform: 'translate(0,0)' }], { duration: 220 });
      }
    }
  }
  function render(s) {
    snapshot = s; setText($('#account-count'), s.accounts.length + ' 个账号');
    const authorizing = (s.jobs || []).some(j => ['starting', 'awaiting_user', 'verifying'].includes(j.state));
    const active = s.accounts.filter(a => a.enabled);
    $('#add-account').dataset.unavailable = String(authorizing);
    $('#restore').dataset.unavailable = String(authorizing);
    renderAccounts(s, active, authorizing);
    const status = $('#connection-status'); status.replaceChildren(text('span', '', 'status-dot' + (active.length !== 1 || s.hosted.enabled || active[0]?.authState !== 'verified' || active[0]?.lastError ? ' warn' : '')),
      text('span', active.length === 1 ? (s.hosted.enabled ? '已选：' + active[0].label + ' · 点击“使用此账号”完成连接配置' : active[0].lastError ? '已配置：' + active[0].label + ' · 点击“修复连接”处理问题' : active[0].authState !== 'verified' ? '已选：' + active[0].label + ' · 点击“检查连接”验证身份' : '已配置：' + active[0].label + ' · 请在 Codex 新任务中验证身份') : active.length > 1 ? '多个账号连接同时启用，请选择要使用的账号' : '尚未选择账号，请点击“使用此账号”'));
    $('#hosted-notice').hidden = !s.hosted.enabled;
    if ($('#copy-check').dataset.alias !== configuredAlias(s)) $('#copy-check').hidden = true;
    $('#restore').hidden = !s.canRestore;
    $('#environment').textContent = s.provider.origin ? 'AI 沿用 Codex 配置的网关 · ' + s.provider.origin : 'AI 沿用 Codex 当前提供方 · ' + s.provider.name;
    renderJobs(s.jobs);
    setBusy(busy);
  }
  function renderJobs(jobs) {
    const area = $('#oauth-job'); const job = [...(jobs || [])].reverse().find(j => ['starting', 'awaiting_user', 'verifying', 'failed', 'complete', 'cancelled'].includes(j.state));
    area.replaceChildren(); area.hidden = !job;
    clearTimeout(pollTimer);
    if (!job) return;
    const titles = job.selectAfterLogin
      ? { starting: '正在准备登录', awaiting_user: '等待浏览器授权', verifying: '正在验证并切换账号', failed: '切换未完成', complete: '账号连接已配置', cancelled: '已取消切换' }
      : { starting: '正在准备授权', awaiting_user: '等待浏览器授权', verifying: '正在核验 Figma 身份', failed: '授权未完成', complete: '授权完成', cancelled: '已取消授权' };
    area.append(text('strong', titles[job.state]));
    area.append(text('p', job.error || job.warning || job.result?.message || (job.state === 'cancelled' ? '需要时可再次点击“使用此账号”。' : job.selectAfterLogin ? '请在 Figma 授权页登录此账号，授权完成后将自动切换。' : '请在 Figma 授权页确认当前登录的账号。')));
    if (['starting', 'awaiting_user'].includes(job.state)) {
      const actions = text('div', '', 'job-actions');
      if (job.authorizationUrl) { const a = text('a', '再次打开授权页'); a.href = job.authorizationUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; actions.append(a); }
      actions.append(button('取消本次授权', 'text-button', () => act('cancel', { id: job.id }).catch(() => {}))); area.append(actions);
    }
    const key = JSON.stringify([job.id, job.state, job.error, job.result?.message]);
    if (!busy && ['complete', 'failed', 'cancelled'].includes(job.state) && terminalJobKey !== key) {
      terminalJobKey = key;
      result(job.error || job.result?.message || (job.state === 'cancelled' ? '本次授权已取消。' : '账号连接已配置。'), job.state === 'failed', job.state === 'complete' && job.result?.needsNewTask ? job.alias : null);
    }
    if (['starting', 'awaiting_user', 'verifying'].includes(job.state)) pollTimer = setTimeout(() => refresh(false), 1800);
  }
  async function refresh(showResult = false) {
    try { const s = await api('status'); render(s); if (showResult) result('账号状态已刷新。'); }
    catch (e) { result(e.message, true); $('#account-count').textContent = '连接不可用'; $('#accounts .loading')?.remove(); }
  }
  function dialog({ title, description, value, submit, extra, run }) {
    $('#dialog-title').textContent = title; $('#dialog-description').textContent = description;
    $('#label-field').hidden = value === undefined;
    $('#account-label').value = value || ''; $('#account-label').required = value !== undefined;
    $('#dialog-submit').textContent = submit; $('#dialog-error').hidden = true;
    $('#dialog-extra').textContent = extra || ''; $('#dialog-extra').hidden = !extra;
    dialogAction = run; $('#account-dialog').showModal();
    if (value !== undefined) $('#account-label').focus();
  }
  function openAdd() {
    command('添加一个 Figma 账号，通过官方授权登录，并核验真实身份。');
    dialog({ title: '添加 Figma 账号', description: '为账号起个名字，然后在浏览器中选择对应的 Figma 账号授权。', value: '', submit: '添加并授权', run: async () => {
      const added = await act('add', { label: $('#account-label').value });
      if (added) { $('#account-dialog').close(); await act('login', { alias: added.alias }); }
    } });
  }
  function openRename(a) {
    dialog({ title: '修改账号名称', description: '名称仅用于识别，已保存的授权保持不变。', value: a.label, submit: '保存名称', run: async () => { await act('rename', { alias: a.alias, label: $('#account-label').value }); $('#account-dialog').close(); } });
  }
  function openSwitch(a, confirmHosted = false) {
    command('将 Codex 的 Figma 连接配置为「' + a.label + '」，并在新任务中验证实际使用的账号。');
    if (!snapshot.hosted.enabled && !confirmHosted) {
      act('use', { alias: a.alias }, '正在连接「' + a.label + '」…').catch(e => { if (e.code === 'HOSTED_CONFLICT') openSwitch(a, true); });
      return;
    }
    dialog({ title: '使用「' + a.label + '」', description: (a.identity?.email || '') + '\n将 Codex 后续的 Figma 连接配置为此账号，并停用其他账号连接。请先完成正在使用 Figma 的任务，配置后在新任务中验证身份。', submit: '确认使用此账号',
      extra: '确认后也会停用官方 Figma 插件的独立连接，避免调用到其他账号。插件和已有授权会保留，可通过“恢复切换前的设置”撤回。',
      run: async () => { await act('use', { alias: a.alias, takeOverHosted: true }, '正在连接「' + a.label + '」…'); $('#account-dialog').close(); } });
  }
  $('#add-account').addEventListener('click', openAdd);
  $('#account-form').addEventListener('submit', async event => { event.preventDefault(); if (busy) return; try { await dialogAction(); } catch (e) { $('#dialog-error').textContent = e.message; $('#dialog-error').hidden = false; } });
  for (const id of ['close-dialog', 'cancel-dialog']) $('#' + id).addEventListener('click', () => { if (!busy) $('#account-dialog').close(); });
  $('#account-dialog').addEventListener('cancel', e => { if (busy) e.preventDefault(); });
  $('#refresh').addEventListener('click', () => refresh(true));
  $('#restore').addEventListener('click', () => dialog({ title: '恢复切换前的设置', description: '恢复上次切换前的 Figma 连接启用状态，包括当时的官方连接状态。若这些设置后来被改过，将停止恢复。恢复后请在新任务中验证身份。', submit: '确认恢复设置', run: async () => { await act('restore', {}); $('#account-dialog').close(); } }));
  $('#copy-check').addEventListener('click', async () => {
    const alias = $('#copy-check').dataset.alias;
    if (!alias || alias !== configuredAlias()) return;
    const prompt = '请只使用自定义 Figma MCP 连接「' + alias + '」调用 whoami，确认当前任务实际使用的账号。不要调用官方托管 Figma 连接。';
    command(prompt);
    try { await navigator.clipboard.writeText(prompt); result('身份检查指令已复制，请粘贴到 Codex 新任务。'); }
    catch { result('请复制以下身份检查指令：\n' + prompt); }
  });
  if (embedded) bridge('ui/initialize', { appInfo: { name: 'Figma Accounts', version: '0.1.0' }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: '2026-01-26' })
    .then(value => { applyHostContext(value?.hostContext); window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*'); refresh(); })
    .catch(e => result(e.message, true));
  else refresh();
  window.addEventListener('focus', () => { if (!busy && !$('#account-dialog').open) refresh(); });
})();
