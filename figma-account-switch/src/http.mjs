import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { ActionError } from './manager.mjs';
import { cleanError } from './rpc.mjs';
import { VERSION } from './version.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
export function createPanelServer(manager, { token = randomBytes(32).toString('hex'), onShutdown } = {}) {
  let origin;
  const server = createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.headers.host !== new URL(origin).host) return json(403, { error: '无效的本地服务地址。' });
    if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: '不允许来自其他网页的请求。' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: '不允许跨站访问。' });
    try {
      const pathname = new URL(req.url, origin).pathname;
      if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (pathname.startsWith('/api/')) {
        const provided = Buffer.from(String(req.headers['x-figma-accounts-session'] || ''));
        const expected = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(401, { error: '此页面的连接已失效，请从插件重新打开。', code: 'SESSION_EXPIRED' });
        if (req.method === 'GET' && pathname === '/api/health') return json(200, { ok: true, name: 'figma-account-switch', version: VERSION, pid: process.pid });
        if (req.method === 'POST' && pathname === '/api/shutdown' && onShutdown) {
          res.once('finish', () => { Promise.resolve().then(onShutdown).catch(() => {}); });
          return json(200, { ok: true, message: '账号面板服务正在停止。' });
        }
        if (req.method === 'GET' && pathname === '/api/status') return json(200, await manager.status());
        if (req.method === 'POST' && pathname === '/api/action') {
          if (!String(req.headers['content-type']).startsWith('application/json')) return json(415, { error: '需要 JSON 请求。' });
          const body = await readJson(req);
          if (typeof body.action !== 'string' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new ActionError('请求格式无效。');
          return json(200, { result: await manager.action(body.action, body.data), snapshot: await manager.status() });
        }
        return json(404, { error: '找不到此操作。' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: '不支持此请求。' });
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const file = files[pathname];
      if (!file) return json(404, { error: '页面不存在。' });
      res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? '' : await readFile(join(web, file[0])));
    } catch (e) { json(e.status || 500, { error: cleanError(e.message), code: e.code || 'INTERNAL_ERROR' }); }
  });
  return {
    server, token,
    async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); origin = 'http://127.0.0.1:' + server.address().port; return { origin, token, port: server.address().port }; },
    close() { return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  };
}
async function readJson(req) {
  let buffer = ''; for await (const part of req) { buffer += part; if (buffer.length > 16384) throw new ActionError('请求内容过大。', 'TOO_LARGE', 413); }
  try { return JSON.parse(buffer); } catch { throw new ActionError('JSON 内容无效。'); }
}
