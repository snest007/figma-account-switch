#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename as pathBasename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectShareFile } from './check-share-safety.mjs';

const repositoryRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const pluginDirectory = 'figma-account-switch';
const markerName = '.release.json';
const generatedBy = 'figma-account-switch/package-release';
const rootFiles = ['README.md', 'LICENSE', '.gitignore', '.agents/plugins/marketplace.json'];
const pluginFiles = ['.codex-plugin/plugin.json', '.mcp.json', 'package.json', 'README.md', 'LICENSE'];
const directoryTypes = {
  skills: new Set(['.md', '.mjs', '.js', '.sh', '.png', '.svg']),
  src: new Set(['.mjs']),
  scripts: new Set(['.mjs', '.sh']),
  web: new Set(['.js', '.css', '.html']),
  assets: new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp', '.gif']),
  test: new Set(['.mjs'])
};
const ignoredNames = new Set(['.DS_Store', 'node_modules', 'output', '.git', '.research', '.playwright-cli', '__MACOSX', '.codex', '.ssh', '.aws', '.config', 'avatars', 'sessions']);
const runtimeName = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|accounts\.json|service\.json|auth\.json|credentials(?:\..*)?|tokens?\.json|cookies?(?:\.(?:json|txt))?|.*\.(?:log|lock|pem|key|p12|pfx|keychain(?:-db)?))$/i;

async function exists(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function noSymlinkParents(path) {
  const full = resolve(path);
  for (let cursor = full; ; cursor = dirname(cursor)) {
    const info = await exists(cursor);
    if (info?.isSymbolicLink()) throw new Error('发布路径不能经过符号链接：' + cursor);
    if (dirname(cursor) === cursor) break;
  }
}

async function canonicalOutput(path) {
  let cursor = resolve(path);
  const missing = [];
  while (!(await exists(cursor))) {
    missing.unshift(pathBasename(cursor));
    cursor = dirname(cursor);
  }
  // macOS's standard /var temporary directory is a system symlink. Canonicalize
  // existing ancestors, then validate the resulting output path before creating it.
  if (cursor === resolve(path) && (await lstat(cursor)).isSymbolicLink()) throw new Error('输出目录本身不能是符号链接。');
  return join(await realpath(cursor), ...missing);
}

function inside(path, root) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

async function sourceFile(relativePath) {
  if (isAbsolute(relativePath) || /[\r\n\0]/.test(relativePath)) throw new Error('无效的打包路径。');
  const path = resolve(repositoryRoot, relativePath);
  if (!inside(path, repositoryRoot)) throw new Error('打包路径超出仓库。');
  await noSymlinkParents(path);
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('缺少普通文件：' + relativePath);
  return { relativePath, path, mode: (info.mode & 0o111) ? 0o755 : 0o644 };
}

async function collectDirectory(name, types, prefix = pluginDirectory) {
  const files = [];
  async function visit(relativePath) {
    const full = resolve(repositoryRoot, relativePath);
    await noSymlinkParents(full);
    const info = await lstat(full);
    if (!info.isDirectory()) throw new Error('缺少打包目录：' + relativePath);
    const entries = (await readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (ignoredNames.has(entry.name) || runtimeName.test(entry.name)) continue;
      const child = join(relativePath, entry.name);
      if (entry.isSymbolicLink()) throw new Error('插件内不能包含符号链接：' + child);
      if (entry.isDirectory()) { await visit(child); continue; }
      if (!entry.isFile() || !types.has(extname(entry.name).toLowerCase())) {
        throw new Error('文件未列入发布允许清单，请先检查用途：' + child);
      }
      files.push(await sourceFile(child));
    }
  }
  await visit(join(prefix, name));
  return files;
}

async function validatePackage() {
  const readJson = async path => JSON.parse(await readFile((await sourceFile(path)).path, 'utf8'));
  const pkg = await readJson(join(pluginDirectory, 'package.json'));
  const manifest = await readJson(join(pluginDirectory, '.codex-plugin/plugin.json'));
  const marketplace = await readJson('.agents/plugins/marketplace.json');
  const mcp = await readJson(join(pluginDirectory, '.mcp.json'));
  if (pkg.name !== pluginDirectory || manifest.name !== pkg.name) throw new Error('插件名称不一致。');
  if (pkg.license !== 'MIT' || manifest.license !== 'MIT') throw new Error('package.json 与插件清单必须声明 MIT 许可证。');
  const rootLicense = await sourceFile('LICENSE');
  const pluginLicense = await sourceFile(join(pluginDirectory, 'LICENSE'));
  if ((await readFile(rootLicense.path, 'utf8')) !== (await readFile(pluginLicense.path, 'utf8'))) {
    throw new Error('仓库与插件的 LICENSE 内容必须相同。');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) || pkg.version !== manifest.version) {
    throw new Error('package.json 与插件清单必须使用相同的发布版本号。');
  }
  const versionFile = await sourceFile(join(pluginDirectory, 'src/version.mjs'));
  const runtime = await import(pathToFileURL(versionFile.path).href);
  if (runtime.VERSION !== pkg.version) throw new Error('运行时代码与插件清单版本不一致。');
  if (manifest.skills !== './skills/' || manifest.mcpServers !== './.mcp.json') throw new Error('插件技能或 MCP 清单路径不正确。');
  const server = mcp.mcpServers?.figma_accounts;
  if (server?.command !== 'node' || server.cwd !== '.' ||
      JSON.stringify(server.args) !== JSON.stringify(['./scripts/mcp.mjs'])) {
    throw new Error('MCP 启动配置必须使用 node 与插件根目录的相对路径。');
  }
  if (marketplace.name !== 'qiang-plugins') throw new Error('插件源名称应为 qiang-plugins。');
  const entry = marketplace.plugins?.find(plugin => plugin.name === pkg.name);
  if (entry?.source?.source !== 'local' || entry.source.path !== './' + pluginDirectory) {
    throw new Error('插件源需要使用仓库内的相对路径 ./' + pluginDirectory + '。');
  }
  if (!entry.policy?.installation || !entry.policy?.authentication || !entry.category) throw new Error('插件源缺少安装策略或分类。');
  for (const path of ['scripts/mcp.mjs', 'scripts/doctor.mjs', 'scripts/stop-service.mjs', 'src/rpc.mjs', 'skills/figma-accounts/SKILL.md', 'assets/icon.png']) {
    await sourceFile(join(pluginDirectory, path));
  }
  return pkg;
}

function runZip(args, cwd) {
  return new Promise((resolveRun, reject) => {
    const proc = spawn('zip', args, { cwd, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    proc.stderr.on('data', chunk => { diagnostic += chunk; });
    proc.on('error', () => reject(new Error('无法运行 zip，请安装系统 ZIP 工具。')));
    proc.on('close', code => code === 0 ? resolveRun() : reject(new Error('ZIP 打包失败：' + diagnostic.trim().slice(0, 300))));
  });
}

async function checkExistingRelease(staging, archive, checksum, version) {
  const stagingInfo = await exists(staging);
  const archiveInfo = await exists(archive);
  const checksumInfo = await exists(checksum);
  if (!stagingInfo && !archiveInfo && !checksumInfo) return;
  if (!stagingInfo?.isDirectory() || stagingInfo.isSymbolicLink()) throw new Error('发布目标已存在且不是本脚本生成的目录，拒绝覆盖。');
  const markerPath = join(staging, markerName);
  const markerInfo = await exists(markerPath);
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) throw new Error('发布目录缺少生成标记，拒绝覆盖。');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (marker.generatedBy !== generatedBy || marker.name !== pluginDirectory || marker.version !== version) {
    throw new Error('发布目录的生成标记不匹配，拒绝覆盖。');
  }
  if ([archiveInfo, checksumInfo].some(info => info && (!info.isFile() || info.isSymbolicLink()))) {
    throw new Error('ZIP 或校验文件不是普通文件，拒绝覆盖。');
  }
}

export async function packageRelease({ outDir = join(repositoryRoot, 'output/releases') } = {}) {
  const pkg = await validatePackage();
  const out = await canonicalOutput(outDir);
  if (out === resolve(repositoryRoot) || ['figma-account-switch', 'scripts', '.agents'].some(name => inside(out, join(repositoryRoot, name)))) {
    throw new Error('输出目录不能覆盖仓库或插件源码。');
  }
  await noSymlinkParents(out);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const basename = pluginDirectory + '-' + pkg.version;
  const staging = join(out, basename);
  const archive = join(out, basename + '.zip');
  const checksum = archive + '.sha256';
  await checkExistingRelease(staging, archive, checksum, pkg.version);
  const files = [];
  for (const path of rootFiles) files.push(await sourceFile(path));
  files.push(...await collectDirectory('scripts', new Set(['.mjs']), ''));
  for (const path of pluginFiles) files.push(await sourceFile(join(pluginDirectory, path)));
  for (const [name, types] of Object.entries(directoryTypes)) files.push(...await collectDirectory(name, types));
  const temporaryRoot = await mkdtemp(join(out, '.' + basename + '-'));
  const temporaryStaging = join(temporaryRoot, basename);
  const temporaryArchive = join(out, '.' + basename + '-' + randomUUID() + '.zip');
  try {
    await mkdir(temporaryStaging);
    for (const file of files) {
      const target = join(temporaryStaging, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.path, target);
      await chmod(target, file.mode);
    }
    const findings = [];
    for (const file of files) findings.push(...inspectShareFile(file.relativePath.split(sep).join('/'), await readFile(join(temporaryStaging, file.relativePath))));
    if (findings.length) throw new Error('发布内容隐私检查未通过：' + findings.map(item => item.path + ':' + item.line + ' ' + item.rule).join(', '));
    await writeFile(join(temporaryStaging, markerName), JSON.stringify({ generatedBy, name: pkg.name, version: pkg.version, files: files.length }, null, 2) + '\n', { mode: 0o644 });
    await runZip(['-q', '-X', '-r', temporaryArchive, basename], temporaryRoot);
    const sha256 = createHash('sha256').update(await readFile(temporaryArchive)).digest('hex');
    // Only replace an existing directory after its ownership marker was checked and the new archive succeeded.
    if (await exists(staging)) await rm(staging, { recursive: true });
    await rename(temporaryStaging, staging);
    await rename(temporaryArchive, archive);
    await writeFile(checksum, sha256 + '  ' + basename + '.zip\n', { mode: 0o644 });
    return { version: pkg.version, files: files.length, staging, archive, checksum, sha256 };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(temporaryArchive, { force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/package-release.mjs [--out-dir DIRECTORY]\n\n生成干净的插件源目录、ZIP 和 SHA-256 文件。默认输出到 output/releases/。');
    return;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--out-dir' && args[1])) throw new Error('用法：node scripts/package-release.mjs [--out-dir DIRECTORY]');
  console.log(JSON.stringify(await packageRelease(args.length ? { outDir: args[1] } : {}), null, 2));
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('发布包生成失败：' + error.message); process.exitCode = 1; });
}
