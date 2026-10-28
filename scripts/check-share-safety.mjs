#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFiles = new Set(['README.md', 'LICENSE', '.gitignore', '.agents/plugins/marketplace.json']);
const pluginFiles = new Set(['.codex-plugin/plugin.json', '.mcp.json', '.gitignore', 'README.md', 'LICENSE', 'package.json', 'assets/icon.png']);
const pluginTypes = {
  src: new Set(['.mjs']), scripts: new Set(['.mjs', '.sh']), test: new Set(['.mjs']),
  web: new Set(['.js', '.css', '.html']), skills: new Set(['.md', '.mjs', '.js', '.sh'])
};
const forbiddenSegments = new Set(['.git', '.codex', '.ssh', '.aws', '.config', 'output', '.research', '.playwright-cli', 'node_modules', 'avatars', 'sessions']);
const privateFile = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|accounts\.json|service\.json|auth\.json|credentials(?:\..*)?|tokens?\.json|cookies?(?:\.(?:json|txt))?|.*\.(?:pem|key|p12|pfx|log|lock|keychain(?:-db)?))$/i;

// Findings deliberately contain no match text, token, credential or account identity.
const literalRules = [
  ['FIGMA_TOKEN', /\bfig[a-z]_[A-Za-z0-9_-]{20,}\b/g],
  ['BEARER_TOKEN', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/gi],
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['API_TOKEN', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,})\b/g],
  ['JWT_TOKEN', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
  ['SESSION_URL', /https?:\/\/[^\s"'<>]+(?:[?#&](?:session|access_token|refresh_token|token|code)=)[A-Za-z0-9._~+%/-]{12,}/gi],
  ['URL_CREDENTIAL', /https?:\/\/[^\s/:"'<>]+:[^\s/@"'<>]+@/gi]
];
const assignedSecret = /(?:\b(?:access_?token|refresh_?token|client_?secret|api_?key|oauth_?token|bearer_?token|authorization|cookie|session_?key|session_?token|token)\b|["'](?:access_token|refresh_token|client_secret|api_key|authorization|cookie|token)["'])\s*[:=]\s*(["'])([^"'\r\n]{8,})\1/gi;
const placeholder = /^(?:test(?:[_ -].*)?|dummy(?:[_ -].*)?|fake(?:[_ -].*)?|fixture(?:[_ -].*)?|example(?:[_ -].*)?|placeholder|redacted|\[.*\]|<.*>|\$\{.*\}|(?:your|replace)[_ -].*)$/i;

function publicPath(path) {
  if (rootFiles.has(path) || path === '.release.json') return true;
  if (/^scripts\/[^/]+\.mjs$/.test(path)) return true;
  const prefix = 'figma-account-switch/';
  if (!path.startsWith(prefix)) return false;
  const local = path.slice(prefix.length);
  if (pluginFiles.has(local)) return true;
  const first = local.split('/')[0];
  return Boolean(pluginTypes[first]?.has(extname(local)));
}

export function inspectShareFile(path, content) {
  const findings = [];
  const add = (rule, line = 1) => {
    if (!findings.some(item => item.rule === rule && item.line === line)) findings.push({ path, rule, line });
  };
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || forbiddenSegments.has(part) || privateFile.test(part))) add('PRIVATE_FILE');
  if (!publicPath(path)) add('UNREVIEWED_FILE');
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const lineAt = index => text.slice(0, index).split('\n').length;
  for (const [rule, expression] of literalRules) {
    const pattern = new RegExp(expression.source, expression.flags);
    for (const match of text.matchAll(pattern)) add(rule, lineAt(match.index));
  }
  for (const match of text.matchAll(new RegExp(assignedSecret.source, assignedSecret.flags))) {
    if (!placeholder.test(match[2])) add('CREDENTIAL_LITERAL', lineAt(match.index));
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
    const domain = match[1].toLowerCase();
    if (!/(?:^|\.)(?:example\.(?:com|net|org)|invalid|test)$/.test(domain)) add('PERSONAL_EMAIL', lineAt(match.index));
  }
  if (path === 'figma-account-switch/.mcp.json') {
    try {
      const mcp = JSON.parse(text);
      const servers = mcp.mcpServers;
      const server = servers?.figma_accounts;
      if (Object.keys(mcp).some(key => key !== 'mcpServers') || !server || Object.keys(servers).some(key => key !== 'figma_accounts') || Object.keys(server).some(key => !['command', 'args', 'cwd'].includes(key))) add('LOCAL_MCP_CREDENTIAL_SETTINGS');
    } catch { add('INVALID_MCP_CONFIG'); }
  }
  return findings;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: null, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('无法检查 Git 文件；请在源码仓库中运行');
  return result.stdout;
}

export async function checkGitShareSafety({ cwd = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  const findings = [];
  const indexed = git(cwd, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
  const paths = new Set(git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean));
  for (const path of paths) {
    try {
      const info = await lstat(join(cwd, path));
      if (info.isSymbolicLink()) { findings.push({ path, rule: 'SYMLINK', line: 1, scope: 'worktree' }); continue; }
      if (!info.isFile()) continue;
      findings.push(...inspectShareFile(path, await readFile(join(cwd, path))).map(item => ({ ...item, scope: 'worktree' })));
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取待上传文件'); }
  }
  for (const record of indexed) {
    const [metadata, path] = record.split('\t');
    const [mode, object] = metadata.split(' ');
    if (mode === '120000') { findings.push({ path, rule: 'SYMLINK', line: 1, scope: 'index' }); continue; }
    findings.push(...inspectShareFile(path, git(cwd, ['cat-file', 'blob', object])).map(item => ({ ...item, scope: 'index' })));
  }
  const commits = git(cwd, ['rev-list', '--all']).toString('utf8').trim().split('\n').filter(Boolean);
  const seen = new Set();
  for (const commit of commits) {
    for (const record of git(cwd, ['ls-tree', '-rz', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean)) {
      const [metadata, path] = record.split('\t');
      const [mode, type, object] = metadata.split(' ');
      if (type !== 'blob' || seen.has(path + ':' + object)) continue;
      seen.add(path + ':' + object);
      if (mode === '120000') { findings.push({ path, rule: 'SYMLINK', line: 1, scope: 'history' }); continue; }
      findings.push(...inspectShareFile(path, git(cwd, ['cat-file', 'blob', object])).map(item => ({ ...item, scope: 'history' })));
    }
  }
  return { ok: findings.length === 0, files: paths.size, historyCommits: commits.length, findings };
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--json')) throw new Error('用法：node scripts/check-share-safety.mjs [--json]');
  const repository = git(process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const report = await checkGitShareSafety({ cwd: repository });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log((report.ok ? '通过' : '阻止上传') + '：' + report.files + ' 个 Git 文件，' + report.historyCommits + ' 个历史提交');
    for (const item of report.findings) console.log(item.scope + ' · ' + item.path + ':' + item.line + ' · ' + item.rule);
    console.log('只检查待上传内容，不读取本机 Figma 账号目录、OAuth 凭据或 Keychain。');
  }
  if (!report.ok) process.exitCode = 1;
}
const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath === fileURLToPath(import.meta.url)) main().catch(() => { console.error('无法完成上传检查，暂不上传。'); process.exitCode = 1; });
