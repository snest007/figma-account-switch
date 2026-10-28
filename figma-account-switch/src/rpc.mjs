import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { VERSION } from './version.mjs';

// This adapter never starts a model turn. OAuth and MCP calls are deterministic.
export const ACCOUNT_RPC_METHODS = Object.freeze(['initialize', 'config/read', 'config/batchWrite',
  'config/mcpServer/reload', 'mcpServer/oauth/login', 'mcpServerStatus/list',
  'mcpServer/tool/call', 'thread/start', 'thread/loaded/list']);
const METHODS = new Set(ACCOUNT_RPC_METHODS);

export class CodexRpc extends EventEmitter {
  constructor({ command = process.env.FIGMA_ACCOUNTS_CODEX || 'codex', args = ['app-server', '--stdio'], cwd } = {}) {
    super();
    this.command = command; this.args = args; this.cwd = cwd;
    this.pending = new Map(); this.nextId = 1; this.closed = false;
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.connect();
    return this.ready;
  }
  async connect() {
    this.proc = spawn(this.command, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', () => {}); // Never log credential-bearing diagnostics.
    this.proc.on('error', () => this.fail(new Error('无法启动 Codex CLI，请检查安装与 PATH。')));
    this.proc.on('exit', () => this.fail(new Error('Codex 管理连接已关闭，请重试。')));
    const lines = createInterface({ input: this.proc.stdout });
    lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && !msg.method) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(msg.id);
        if (msg.error) {
          const error = new Error(cleanError(msg.error.message));
          error.rpcCode = msg.error.code; entry.reject(error);
        } else entry.resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        // No agent turns, shell commands, or automatic permission grants.
        this.proc.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'This client only supports account management.' } }) + '\n');
      } else if (msg.method) this.emit(msg.method, msg.params);
    });
    this.info = await this.request('initialize', {
      clientInfo: { name: 'figma_account_switch', title: 'Figma Accounts', version: VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false }
    }, 12000);
    this.proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return this;
  }
  request(method, params = {}, timeout = 30000) {
    if (!METHODS.has(method)) return Promise.reject(new Error('禁止调用模型或非账号管理方法：' + method));
    if (method === 'mcpServer/tool/call' && params.tool !== 'whoami') return Promise.reject(new Error('验证过程只允许调用 whoami。'));
    if (this.closed || !this.proc?.stdin?.writable) return Promise.reject(new Error('Codex 管理连接不可用。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 请求超时，请稍后重试。')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  fail(error) {
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  close() { this.fail(new Error('操作已取消。')); this.proc?.kill('SIGTERM'); }
}

export function cleanError(value) {
  return String(value || '操作失败。')
    .replace(/https?:\/\/[^\s<>"']+/g, '[服务地址]')
    .replace(/(Bearer\s+|(?:access_token|refresh_token|id_token|client_secret|api_key)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[已隐藏]')
    .slice(0, 500);
}
