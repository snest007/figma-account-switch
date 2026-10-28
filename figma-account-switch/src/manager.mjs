import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { CodexRpc, cleanError } from './rpc.mjs';
import { downloadFigmaAvatar } from './avatar.mjs';

export const FIGMA_URL = 'https://mcp.figma.com/mcp';
export const HOSTED_FIGMA = 'connector_68df038e0ba48191908c8434991bbac2';
export const dataDirectory = () => process.env.FIGMA_ACCOUNTS_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Figma Account Switch');
const now = () => new Date().toISOString();
const aliasPattern = /^[A-Za-z0-9_-]+$/;
const enabled = value => value !== false;

export class ActionError extends Error {
  constructor(message, code = 'ACTION_FAILED', status = 400) { super(message); this.code = code; this.status = status; }
}
export async function atomicJson(path, value) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}
export function parseIdentity(result) {
  if (result?.isError) throw new ActionError('Figma 身份检查未完成，请稍后重试。', 'IDENTITY_CHECK_FAILED');
  const candidates = [result?.structuredContent];
  for (const block of result?.content || []) {
    if (block.type === 'text') { try { candidates.push(JSON.parse(block.text)); } catch {} }
  }
  // Figma may wrap account details in `whoami`; keep supporting the original flat response.
  const identity = candidates.flatMap(x => [x?.whoami, x])
    .find(x => x && typeof x.email === 'string' && x.email.includes('@'));
  if (!identity) throw new ActionError('未收到可验证的 Figma 身份，不能将连接标为已验证。', 'IDENTITY_UNAVAILABLE');
  return { email: identity.email, handle: identity.handle || '',
    plans: (identity.plans || []).map(p => ({ name: p.name, seat: p.seat, type: p.type })), checkedAt: now() };
}

export class AccountManager {
  constructor({ dir = dataDirectory(), rpcFactory = opts => new CodexRpc(opts), browserOpen = openBrowser, avatarDownload = downloadFigmaAvatar } = {}) {
    this.dir = dir; this.file = join(dir, 'accounts.json'); this.rpcFactory = rpcFactory;
    this.browserOpen = browserOpen; this.avatarDownload = avatarDownload; this.jobs = new Map(); this.queue = Promise.resolve();
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try { this.db = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new ActionError('账号记录无法读取，请保留文件并修复后再启动。'); this.db = { version: 1, accounts: {}, lastSwitch: null }; }
    if (this.db.version !== 1 || !this.db.accounts) throw new ActionError('账号记录版本不受支持。');
    return this;
  }
  async rpc() {
    if (!this.client || this.client.closed) { this.client = this.rpcFactory({ cwd: homedir() }); await this.client.start(); }
    return this.client;
  }
  async config(cwd) {
    const result = await (await this.rpc()).request('config/read', { includeLayers: true, ...(cwd ? { cwd } : {}) });
    const user = result.layers?.find(l => l.name.type === 'user' && !l.name.profile);
    if (!user) throw new ActionError('无法定位 Codex 用户配置，未进行任何修改。');
    return { ...result, user };
  }
  async save() { await atomicJson(this.file, this.db); }
  exclusive(fn) {
    const run = this.queue.then(async () => {
      let handle;
      try { handle = await open(join(this.dir, 'mutation.lock'), 'wx', 0o600); }
      catch { throw new ActionError('另一个窗口正在修改账号配置，请稍后重试。', 'BUSY', 409); }
      try { return await fn(); }
      finally { await handle.close(); await unlink(join(this.dir, 'mutation.lock')).catch(() => {}); }
    });
    this.queue = run.catch(() => {}); return run;
  }
  rows(snapshot) {
    return Object.entries(snapshot.config.mcp_servers || {})
      .filter(([, s]) => s.url === FIGMA_URL)
      .map(([alias, server]) => {
        const stored = this.db.accounts[alias] || {};
        const hasAuthorization = headers => Object.keys(headers || {}).some(k => k.toLowerCase() === 'authorization');
        const customAuth = !!(server.bearer_token_env_var || hasAuthorization(server.http_headers) || hasAuthorization(server.env_http_headers) || server.http_headers_helper);
        return { alias, label: stored.label || (alias === 'figma' ? '已有 Figma 连接' : alias),
          enabled: enabled(server.enabled), imported: !stored.createdAt, identity: stored.identity || null,
          avatar: stored.avatar?.email?.toLowerCase() === stored.identity?.email?.toLowerCase() && stored.avatar
            ? { dataUrl: stored.avatar.dataUrl, updatedAt: stored.avatar.updatedAt } : null,
          authState: stored.authState || 'unknown', lastError: stored.lastError || null, customAuth,
          managed: !!stored.createdAt,
          userEditable: !!snapshot.user.config?.mcp_servers?.[alias],
          hasProjectOverride: !!snapshot.origins?.[`mcp_servers.${alias}.enabled`]?.name?.dotCodexFolder };
      });
  }
  async status() {
    const s = await this.config();
    const provider = s.config.model_provider || 'openai';
    const p = s.config.model_providers?.[provider];
    let origin = null; try { origin = new URL(p?.base_url).origin; } catch {}
    const hostedInstalled = Object.keys(s.config.plugins || {}).some(k => k.startsWith('figma@') && s.config.plugins[k]?.enabled !== false);
    return { accounts: this.rows(s), hosted: { installed: hostedInstalled, enabled: enabled(s.config.apps?.[HOSTED_FIGMA]?.enabled) && hostedInstalled },
      provider: { name: provider, origin, model: s.config.model, extraModelCalls: false },
      desktop: { state: 'unverified', message: '授权检查验证此连接；Codex 已打开任务的身份需在任务中确认。' },
      pendingDesktop: this.db.lastSwitch?.phase === 'applied' ? {
        alias: this.db.lastSwitch.restoredAt ? (this.rows(s).filter(a => a.enabled).length === 1 ? this.rows(s).find(a => a.enabled).alias : null) : this.db.lastSwitch.target,
        at: this.db.lastSwitch.restoredAt || this.db.lastSwitch.at
      } : null,
      canRestore: ['applied', 'prepared'].includes(this.db.lastSwitch?.phase) && !this.db.lastSwitch.restoredAt,
      jobs: [...this.jobs.values()].map(publicJob) };
  }
  async writeConfig(snapshot, edits) {
    // Narrow whitelist: this plugin cannot alter model/provider/keys or unrelated MCP servers.
    for (const edit of edits) {
      const match = edit.keyPath.match(/^mcp_servers\.([A-Za-z0-9_-]+)(\.enabled)?$/);
      const isHosted = edit.keyPath === `apps.${HOSTED_FIGMA}.enabled` && typeof edit.value === 'boolean';
      const isToggle = match?.[2] && snapshot.config.mcp_servers?.[match[1]]?.url === FIGMA_URL && typeof edit.value === 'boolean';
      const isNew = match && !match[2] && match[1].startsWith('figma_account_') && !snapshot.config.mcp_servers?.[match[1]]
        && edit.value?.url === FIGMA_URL && edit.value?.enabled === false && Object.keys(edit.value).length === 2;
      if (!isHosted && !isToggle && !isNew) throw new ActionError('拒绝修改非 Figma 配置。');
    }
    const result = await (await this.rpc()).request('config/batchWrite', {
      edits, filePath: snapshot.user.name.file, expectedVersion: snapshot.user.version, reloadUserConfig: false
    });
    if (result.overriddenMetadata) throw new ActionError('配置被更高优先级设置覆盖。请检查项目或组织策略。', 'CONFIG_OVERRIDDEN');
    return result;
  }
  async add(label) {
    label = validateLabel(label);
    return this.exclusive(async () => {
      const s = await this.config();
      const alias = 'figma_account_' + randomUUID().replaceAll('-', '').slice(0, 12);
      await this.writeConfig(s, [{ keyPath: `mcp_servers.${alias}`, value: { url: FIGMA_URL, enabled: false }, mergeStrategy: 'replace' }]);
      this.db.accounts[alias] = { label, createdAt: now(), authState: 'not_authorized' };
      await this.save(); return { alias, message: '账号连接已创建。下一步在浏览器中授权。' };
    });
  }
  async account(alias, snapshot) {
    if (!aliasPattern.test(alias || '')) throw new ActionError('账号标识无效。');
    const s = snapshot || await this.config();
    const row = this.rows(s).find(r => r.alias === alias);
    if (!row) throw new ActionError('找不到这条 Figma 连接。');
    return { s, row };
  }
  async rename(alias, label) {
    label = validateLabel(label);
    return this.exclusive(async () => { await this.account(alias); this.db.accounts[alias] = { ...this.db.accounts[alias], label }; await this.save(); return { message: '账号名称已更新。' }; });
  }
  async importAvatar(alias, email, url) {
    return this.exclusive(async () => {
      const { row } = await this.account(alias);
      const matches = account => account?.authState === 'verified' && typeof email === 'string'
        && account.identity?.email?.toLowerCase() === email.trim().toLowerCase();
      if (!matches(row)) throw new ActionError('头像所属邮箱必须与已验证的 Figma 账号一致。', 'IDENTITY_MISMATCH');
      let image;
      try { image = await this.avatarDownload(url); }
      catch (e) { throw new ActionError(cleanError(e.message), 'AVATAR_UNAVAILABLE'); }
      if (!matches(this.db.accounts[alias])) throw new ActionError('账号状态已变化，请检查身份后重试。', 'IDENTITY_MISMATCH');
      this.db.accounts[alias].avatar = { ...image, email: row.identity.email, updatedAt: now() };
      await this.save();
      return { message: '已保存此账号的 Figma 头像。', alias };
    });
  }
  async select(alias, takeOverHosted = false) {
    return this.exclusive(() => this.applySelection(alias, takeOverHosted));
  }
  activeLogin(exceptId) {
    return [...this.jobs.values()].find(j => j.id !== exceptId && j.kind === 'login' && ['starting', 'awaiting_user', 'verifying'].includes(j.state));
  }
  async applySelection(alias, takeOverHosted, loginJobId) {
    if (this.activeLogin(loginJobId)) throw new ActionError('已有授权正在进行，请先完成或取消。', 'BUSY', 409);
    const { s, row } = await this.account(alias);
    if (row.customAuth) throw new ActionError('这条连接使用自定义请求头或 Token，请新建独立 OAuth 账号。');
    const all = this.rows(s);
    if (all.some(a => !a.userEditable)) throw new ActionError('检测到项目或组织管理的 Figma 连接，不能通过用户配置完整切换。', 'CONFIG_OVERRIDDEN');
    const hostedInstalled = Object.keys(s.config.plugins || {}).some(k => k.startsWith('figma@') && s.config.plugins[k]?.enabled !== false);
    const hostedActive = hostedInstalled && enabled(s.config.apps?.[HOSTED_FIGMA]?.enabled);
    if (hostedActive && !takeOverHosted) throw new ActionError('官方托管 Figma 工具仍处于启用状态。切换时需要一并停用它，避免调用旧账号。', 'HOSTED_CONFLICT', 409);
    // Always verify today's authorization, including accounts with no cached identity.
    await this.verify(alias);
    if (this.activeLogin(loginJobId)) throw new ActionError('已有授权正在进行，请先完成或取消。', 'BUSY', 409);
    if (!hostedActive && all.every(a => a.enabled === (a.alias === alias))) {
      return { message: '此账号已配置，授权检查通过。请在 Codex 新任务中确认实际使用的账号。', needsNewTask: true };
    }
    const changes = all.map(a => ({ keyPath: `mcp_servers.${a.alias}.enabled`, before: a.enabled, after: a.alias === alias }));
    if (hostedActive) changes.push({ keyPath: `apps.${HOSTED_FIGMA}.enabled`, before: true, after: false });
    const journal = { target: alias, at: now(), changes, phase: 'prepared' };
    this.db.lastSwitch = journal; await this.save();
    try {
      await this.writeConfig(s, changes.map(x => ({ keyPath: x.keyPath, value: x.after, mergeStrategy: 'replace' })));
      journal.phase = 'applied'; await this.save();
    } catch (e) { journal.phase = 'failed'; journal.error = cleanError(e.message); await this.save(); throw e; }
    return { message: '账号连接已配置。请在 Codex 新任务中验证身份；已打开的任务可能仍使用原账号。', needsNewTask: true };
  }
  async use(alias, takeOverHosted = false) {
    return this.exclusive(async () => {
      const retryWrongIdentity = this.db.accounts[alias]?.lastErrorCode === 'IDENTITY_MISMATCH';
      try { return await this.applySelection(alias, takeOverHosted); }
      catch (e) {
        // A wrong account must fail once; only a later, explicit click may reopen OAuth.
        if (e.code !== 'AUTH_REQUIRED' && !(e.code === 'IDENTITY_MISMATCH' && retryWrongIdentity)) throw e;
        const job = await this.login(alias, { selectAfterLogin: true, takeOverHosted });
        return { ...job, message: '请在 Figma 完成账号授权，完成后将自动使用此账号。' };
      }
    });
  }
  async restore() {
    return this.exclusive(async () => {
      if (this.activeLogin()) throw new ActionError('已有授权正在进行，请先完成或取消。', 'BUSY', 409);
      const record = this.db.lastSwitch;
      if (!record || record.restoredAt) throw new ActionError('没有可恢复的切换记录。');
      const s = await this.config();
      for (const c of record.changes) {
        const alias = c.keyPath.match(/^mcp_servers\.([A-Za-z0-9_-]+)\.enabled$/)?.[1];
        const actual = alias ? enabled(s.config.mcp_servers?.[alias]?.enabled) : enabled(s.config.apps?.[HOSTED_FIGMA]?.enabled);
        if (actual !== c.after) throw new ActionError('切换后配置又发生了变化，已停止恢复以保留后续修改。', 'RESTORE_CONFLICT', 409);
      }
      await this.writeConfig(s, record.changes.map(c => ({ keyPath: c.keyPath, value: c.before, mergeStrategy: 'replace' })));
      record.restoredAt = now(); await this.save();
      return { message: '已恢复上次切换前的连接设置。请在新任务中确认。' };
    });
  }
  async verify(alias) {
    const { s, row } = await this.account(alias);
    if (row.customAuth) throw new ActionError('此连接不是独立 OAuth 认证，无法纳入账号切换。');
    const worker = this.rpcFactory({ cwd: homedir() });
    try {
      await worker.start();
      const config = { 'mcp_optional_startup_grace_ms': 0, 'features.apps': false };
      for (const name of Object.keys(s.config.mcp_servers || {})) {
        if (!aliasPattern.test(name)) throw new ActionError('检测到特殊格式的 MCP 名称，无法安全隔离检查。');
        config[`mcp_servers.${name}.enabled`] = name === alias;
      }
      config.plugins = Object.fromEntries(Object.keys(s.config.plugins || {}).map(name => [name, { enabled: false }]));
      // Ephemeral MCP diagnostic container. No turn/start, prompt, or model request.
      const t = await worker.request('thread/start', { ephemeral: true, cwd: homedir(), config }, 90000);
      const threadId = t.thread.id;
      const inventory = await worker.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100 }, 90000);
      const server = inventory.data.find(x => x.name === alias);
      const toolNames = Object.entries(server?.tools || {}).map(([key, value]) => value.name || key);
      const hasIdentity = toolNames.some(name => name === 'whoami' || name.endsWith('__whoami'));
      if (server?.authStatus === 'notLoggedIn') throw new ActionError('Figma 账号需要授权，点击“使用此账号”即可继续。', 'AUTH_REQUIRED');
      if (!server || !hasIdentity) throw new ActionError('Figma 连接暂时不可用，请稍后再点击“使用此账号”。', 'CONNECTION_UNAVAILABLE');
      const identity = parseIdentity(await worker.request('mcpServer/tool/call', { threadId, server: alias, tool: 'whoami', arguments: {} }, 60000));
      const previous = this.db.accounts[alias] || {};
      if (previous.identity?.email && previous.identity.email.toLowerCase() !== identity.email.toLowerCase()) {
        throw new ActionError('此次授权登录了另一账号：' + identity.email + '。请再次点击“使用此账号”并登录原账号，或将其添加为新账号。', 'IDENTITY_MISMATCH');
      }
      const duplicate = Object.entries(this.db.accounts).find(([other, a]) => other !== alias && a.identity?.email?.toLowerCase() === identity.email.toLowerCase());
      this.db.accounts[alias] = { ...previous, identity, authState: 'verified', lastError: null, lastErrorCode: null };
      await this.save();
      return { identity, tools: toolNames, duplicateOf: duplicate?.[0] || null,
        message: duplicate ? '身份已验证；同一账号还存在于另一条连接，请检查是否选错浏览器账号。' : 'Figma 账号授权已验证。此检查未调用模型。' };
    } catch (e) {
      this.db.accounts[alias] = { ...this.db.accounts[alias], authState: 'needs_check', lastError: cleanError(e.message), lastErrorCode: e.code || null };
      await this.save(); throw e;
    } finally { worker.close(); }
  }
  async login(alias, { selectAfterLogin = false, takeOverHosted = false } = {}) {
    const { row } = await this.account(alias);
    if (row.customAuth) throw new ActionError('请为此账号新建独立 OAuth 连接。');
    if (this.activeLogin()) throw new ActionError('已有授权正在进行，请先完成或取消。', 'BUSY', 409);
    const id = randomUUID(); const worker = this.rpcFactory({ cwd: homedir() });
    const job = { id, alias, kind: 'login', state: 'starting', startedAt: now(), selectAfterLogin, takeOverHosted, worker };
    this.jobs.set(id, job);
    this.runLogin(job).catch(() => {});
    return publicJob(job);
  }
  async runLogin(job) {
    const worker = job.worker;
    try {
      await worker.start();
      const completion = new Promise((resolve, reject) => {
        job.timer = setTimeout(() => reject(new Error('授权已超时，请重新开始。')), 310000);
        job.reject = reject;
        worker.on('mcpServer/oauthLogin/completed', e => {
          if (e.name === job.alias) e.success ? resolve(e) : reject(new Error(e.error || '授权未完成。'));
        });
      });
      completion.catch(() => {});
      const result = await worker.request('mcpServer/oauth/login', { name: job.alias, timeoutSecs: 300 }, 45000);
      const url = result.authorizationUrl;
      validateAuthUrl(url);
      job.authorizationUrl = url; job.state = 'awaiting_user';
      await this.browserOpen(url).catch(() => { job.warning = '未能自动打开浏览器，请点击下面的授权链接。'; });
      await completion;
      job.authorizationUrl = undefined; job.state = 'verifying';
      job.result = job.selectAfterLogin
        ? await this.exclusive(() => this.applySelection(job.alias, job.takeOverHosted, job.id))
        : await this.verify(job.alias);
      job.state = 'complete';
    } catch (e) {
      if (job.state !== 'cancelled') {
        job.state = 'failed'; job.error = cleanError(e.message);
        // A completed OAuth flow may have replaced this alias's credentials.
        // If the browser chose a different person, do not leave that alias enabled.
        if (e.code === 'IDENTITY_MISMATCH') {
          try {
            await this.exclusive(async () => {
              const { s, row } = await this.account(job.alias);
              if (row.enabled) await this.writeConfig(s, [{ keyPath: `mcp_servers.${job.alias}.enabled`, value: false, mergeStrategy: 'replace' }]);
            });
            job.error += ' 这条连接已停用，请再次点击“使用此账号”并登录原账号。';
          } catch { job.error += ' 未能停用此连接，请暂时停止在 Codex 中使用它并检查设置。'; }
        }
      }
    }
    finally { clearTimeout(job.timer); job.authorizationUrl = undefined; worker.close(); }
  }
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new ActionError('找不到这次授权。');
    if (!['starting', 'awaiting_user'].includes(job.state)) throw new ActionError('这次授权已结束或正在验证。');
    job.state = 'cancelled'; job.reject?.(new Error('授权已取消。')); job.worker.close();
    return { message: '授权已取消；浏览器中的授权页可关闭。' };
  }
  async action(action, data = {}) {
    switch (action) {
      case 'status': return this.status();
      case 'add': return this.add(data.label);
      case 'rename': return this.rename(data.alias, data.label);
      case 'import_avatar': return this.importAvatar(data.alias, data.email, data.url);
      case 'select': return this.select(data.alias, data.takeOverHosted === true);
      case 'use': return this.use(data.alias, data.takeOverHosted === true);
      case 'verify': return this.verify(data.alias);
      case 'login': return this.login(data.alias);
      case 'cancel': return this.cancel(data.id);
      case 'restore': return this.restore();
      default: throw new ActionError('不支持的操作。');
    }
  }
  close() { this.client?.close(); for (const j of this.jobs.values()) { clearTimeout(j.timer); j.worker?.close(); } }
}

function publicJob({ id, alias, kind, state, startedAt, selectAfterLogin, error, warning, result, authorizationUrl }) { return { id, alias, kind, state, startedAt, selectAfterLogin, error, warning, result, authorizationUrl }; }
function validateLabel(label) {
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 40 || /[\x00-\x1f]/.test(label)) throw new ActionError('请输入 1–40 个字符的账号名称。');
  return label.trim();
}
function validateAuthUrl(value) {
  let u; try { u = new URL(value); } catch { throw new ActionError('Codex 没有返回有效的授权地址。'); }
  if (u.protocol !== 'https:' || !(u.hostname === 'figma.com' || u.hostname.endsWith('.figma.com'))) throw new ActionError('授权地址不是 Figma 官方域名，已停止打开。');
}
async function openBrowser(url) {
  validateAuthUrl(url);
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  await new Promise((resolve, reject) => {
    const p = spawn(command, [url], { stdio: 'ignore' });
    p.on('error', () => reject(new Error('无法打开浏览器，请点击授权链接继续。')));
    p.on('exit', code => code === 0 ? resolve() : reject(new Error('无法打开浏览器，请重试。')));
  });
}
