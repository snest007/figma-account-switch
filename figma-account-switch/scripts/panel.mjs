#!/usr/bin/env node
import { ensureService, panelUrl, requestService } from '../src/service-client.mjs';
import { spawn } from 'node:child_process';
const info = await ensureService();
if (process.argv.includes('--status')) console.log(JSON.stringify(await requestService(info), null, 2));
else if (process.argv.includes('--open')) { const p = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [panelUrl(info)], { stdio: 'ignore' }); p.on('error', () => console.error('请通过 Codex 面板打开返回地址。')); console.log(JSON.stringify({ url: panelUrl(info) })); }
else console.log(JSON.stringify({ url: panelUrl(info), message: '在 Codex 内置浏览器打开此地址。' }));
