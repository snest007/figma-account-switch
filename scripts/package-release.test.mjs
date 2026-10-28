import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'figma-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'README.md': 'Release installation instructions.\n',
    'LICENSE': 'MIT\n',
    '.gitignore': 'output/\n',
    '.agents/plugins/marketplace.json': JSON.stringify({ name: 'qiang-plugins', plugins: [{ name: 'figma-account-switch', source: { source: 'local', path: './figma-account-switch' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }),
    'figma-account-switch/package.json': JSON.stringify({ name: 'figma-account-switch', version: '0.1.1', type: 'module', license: 'MIT' }),
    'figma-account-switch/.codex-plugin/plugin.json': JSON.stringify({ name: 'figma-account-switch', version: '0.1.1', license: 'MIT', skills: './skills/', mcpServers: './.mcp.json' }),
    'figma-account-switch/.mcp.json': JSON.stringify({ mcpServers: { figma_accounts: { command: 'node', args: ['./scripts/mcp.mjs'], cwd: '.' } } }),
    'figma-account-switch/README.md': 'Plugin instructions.\n',
    'figma-account-switch/LICENSE': 'MIT\n',
    'figma-account-switch/src/version.mjs': "export const VERSION = '0.1.1';\n",
    'figma-account-switch/src/rpc.mjs': '// Test fixture.\n',
    'figma-account-switch/scripts/mcp.mjs': '// Test fixture.\n',
    'figma-account-switch/scripts/doctor.mjs': '// Test fixture.\n',
    'figma-account-switch/scripts/stop-service.mjs': '// Test fixture.\n',
    'figma-account-switch/skills/figma-accounts/SKILL.md': '---\nname: figma-accounts\n---\n',
    'figma-account-switch/web/index.html': '<html></html>\n',
    'figma-account-switch/assets/icon.png': 'test fixture image\n',
    'figma-account-switch/test/example.test.mjs': '// Test fixture.\n'
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await mkdir(join(root, 'scripts'));
  const script = join(root, 'scripts/package-release.mjs');
  await copyFile(new URL('./package-release.mjs', import.meta.url), script);
  await copyFile(new URL('./check-share-safety.mjs', import.meta.url), join(root, 'scripts/check-share-safety.mjs'));
  return { root, script, ...(await import(pathToFileURL(script).href)), outDir: join(root, 'output/releases') };
}

test('CLI packages hidden manifests from an unrelated working directory and excludes runtime files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'figma-account-switch/scripts/.env'), 'TEST_SECRET_SENTINEL\n');
  await writeFile(join(f.root, 'figma-account-switch/src/service.json'), '{"test":"runtime"}\n');
  await mkdir(join(f.root, 'output'));
  await writeFile(join(f.root, 'output/not-for-release.txt'), 'private test output\n');
  const result = JSON.parse(execFileSync(process.execPath, [f.script, '--out-dir', f.outDir], { cwd: tmpdir(), encoding: 'utf8' }));
  const entries = execFileSync('unzip', ['-Z1', result.archive], { encoding: 'utf8' }).split('\n');
  const prefix = 'figma-account-switch-0.1.1/';
  assert.ok(entries.includes(prefix + '.agents/plugins/marketplace.json'));
  assert.ok(entries.includes(prefix + 'figma-account-switch/.codex-plugin/plugin.json'));
  assert.ok(entries.includes(prefix + 'figma-account-switch/.mcp.json'));
  assert.ok(entries.includes(prefix + 'figma-account-switch/LICENSE'));
  assert.ok(entries.includes(prefix + 'scripts/package-release.mjs'));
  assert.ok(entries.includes(prefix + 'figma-account-switch/scripts/doctor.mjs'));
  assert.ok(entries.includes(prefix + 'figma-account-switch/scripts/stop-service.mjs'));
  assert.ok(entries.every(path => !/(?:\.env|service\.json|not-for-release)/.test(path)));
  assert.equal(result.sha256, createHash('sha256').update(await readFile(result.archive)).digest('hex'));
  assert.equal((await readFile(result.checksum, 'utf8')).split('  ')[0], result.sha256);
});

test('release refuses source symlinks that could copy files from outside the plugin', async t => {
  const f = await fixture(t);
  await symlink(join(f.root, 'README.md'), join(f.root, 'figma-account-switch/src/leak.mjs'));
  await assert.rejects(f.packageRelease({ outDir: f.outDir }), /符号链接/);
});

test('release refuses a credential pasted into an otherwise allowed source file without exposing it', async t => {
  const f = await fixture(t);
  const secret = 'figd_' + 'Z'.repeat(40);
  await writeFile(join(f.root, 'figma-account-switch/src/rpc.mjs'), 'export const accidentallyPasted = ' + JSON.stringify(secret) + ';\n');
  await assert.rejects(f.packageRelease({ outDir: f.outDir }), error => {
    assert.match(error.message, /隐私检查未通过/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('release refuses local MCP credential settings even when the launch command is valid', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'figma-account-switch/.mcp.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.mcpServers.figma_accounts.env = { PRIVATE_SETTING: 'personal-value' };
  await writeFile(path, JSON.stringify(config));
  await assert.rejects(f.packageRelease({ outDir: f.outDir }), /LOCAL_MCP_CREDENTIAL_SETTINGS/);
});

test('release refuses unknown data files and inconsistent versions', async t => {
  const f = await fixture(t);
  const data = join(f.root, 'figma-account-switch/src/unreviewed.json');
  await writeFile(data, '{}\n');
  await assert.rejects(f.packageRelease({ outDir: f.outDir }), /允许清单/);
  await rm(data);
  await writeFile(join(f.root, 'figma-account-switch/package.json'), JSON.stringify({ name: 'figma-account-switch', version: '0.2.0', type: 'module', license: 'MIT' }));
  await assert.rejects(f.packageRelease({ outDir: f.outDir }), /相同的发布版本号/);
});

test('release preserves an existing unowned output directory', async t => {
  const f = await fixture(t);
  const target = join(f.outDir, 'figma-account-switch-0.1.1');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'keep.txt'), 'keep\n');
  await assert.rejects(f.packageRelease({ outDir: f.outDir }), /缺少生成标记/);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'keep\n');
});

test('release rebuilds its own output and refuses to write over plugin source', async t => {
  const f = await fixture(t);
  const first = await f.packageRelease({ outDir: f.outDir });
  const second = await f.packageRelease({ outDir: f.outDir });
  assert.equal(first.archive, second.archive);
  assert.equal(first.files, second.files);
  await assert.rejects(f.packageRelease({ outDir: join(f.root, 'figma-account-switch/release') }), /覆盖仓库或插件源码/);
});
