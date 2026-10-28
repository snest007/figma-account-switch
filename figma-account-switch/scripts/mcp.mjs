#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { ensureService, panelUrl, requestService } from '../src/service-client.mjs';
import { cleanError } from '../src/rpc.mjs';
import { VERSION } from '../src/version.mjs';

const RESOURCE = 'ui://figma-accounts/panel-v2.html';
const tools = [
  { name: 'open_accounts_panel', title: '打开 Figma 账号面板', description: '打开 Figma 多账号管理界面。优先使用 Codex 内嵌应用或聊天旁面板；未渲染时才打开 panelUrl 作为备用入口。没有模型推理或认证变更。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: RESOURCE }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } },
  { name: 'list_accounts', title: '查看 Figma 账号', description: '读取自定义 Figma MCP 连接、已验证身份和配置状态。配置中的默认账号不等于旧任务的实际身份。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'manage_account', title: '管理 Figma 账号', description: '仅按用户明确选择添加、授权、验证或切换 Figma 账号。不调用模型，不修改网关。use 自动验证并切换，缺少授权时登录后继续；select 实时验证。hosted 冲突时需用户明确允许停用官方托管 Figma 工具。import_avatar 仅在用户要求显示头像后，使用 Figma 账号页面已观察到的邮箱与头像 URL，按邮箱匹配 alias；禁止猜测头像或使用其他账号图片。', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'rename', 'use', 'select', 'verify', 'login', 'cancel', 'restore', 'import_avatar'] }, data: { type: 'object', properties: { alias: { type: 'string' }, label: { type: 'string' }, email: { type: 'string' }, url: { type: 'string' }, id: { type: 'string' }, takeOverHosted: { type: 'boolean' } }, additionalProperties: false } }, required: ['action', 'data'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, _meta: { ui: { visibility: ['model', 'app'] } } }
];
async function widget() {
  const [html, css, js] = await Promise.all(['index.html', 'style.css', 'app.js'].map(name => readFile(new URL('../web/' + name, import.meta.url), 'utf8')));
  return html.replace('<link rel="stylesheet" href="/style.css">', '<style>' + css + '</style>')
    .replace('<script src="/app.js" defer></script>', '<script>window.FIGMA_ACCOUNTS_EMBEDDED=true;</script>')
    .replace('</body>', '<script>' + js + '</script></body>');
}
async function handle(method, params = {}) {
  switch (method) {
    case 'initialize': return { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'figma-account-switch', version: VERSION }, instructions: 'Manage only custom Figma MCP connections. No model calls. Display configured identity separately from current desktop-task identity. Open panelUrl with open_in_codex if embedded UI is unavailable. OAuth credentials remain managed by Codex.' };
    case 'ping': return {};
    case 'tools/list': return { tools };
    case 'resources/list': return { resources: [{ uri: RESOURCE, name: 'Figma Accounts', mimeType: 'text/html;profile=mcp-app' }] };
    case 'resources/templates/list': return { resourceTemplates: [] };
    case 'resources/read':
      if (params.uri !== RESOURCE) throw new Error('Unknown resource');
      return { contents: [{ uri: RESOURCE, mimeType: 'text/html;profile=mcp-app', text: await widget(), _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } }, 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] } } }] };
    case 'tools/call': {
      if (!tools.some(t => t.name === params.name)) throw new Error('Unknown tool');
      const info = await ensureService();
      if (params.name === 'manage_account') {
        const { action, data } = params.arguments || {};
        const value = await requestService(info, action, data);
        return { structuredContent: value, content: [{ type: 'text', text: value.result?.message || JSON.stringify(value.result) }] };
      }
      const snapshot = await requestService(info);
      return { structuredContent: { snapshot, panelUrl: panelUrl(info) }, content: [{ type: 'text', text: params.name === 'open_accounts_panel' ? 'Figma 账号面板：' + panelUrl(info) + '\n如未显示内嵌界面，请在 Codex 内置浏览器中打开。' : JSON.stringify(snapshot) }] };
    }
    default: throw new Error('Method not found');
  }
}
const lines = createInterface({ input: process.stdin });
lines.on('line', async line => {
  if (line.length > 1000000) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  try { const result = await handle(msg.method, msg.params); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n'); }
  catch (e) {
    const result = { isError: true, content: [{ type: 'text', text: cleanError(e.message) }], structuredContent: { error: cleanError(e.message), code: e.code } };
    process.stdout.write(JSON.stringify(msg.method === 'tools/call' ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: cleanError(e.message) } }) + '\n');
  }
});
