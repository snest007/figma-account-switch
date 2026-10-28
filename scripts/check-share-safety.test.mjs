import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkGitShareSafety, inspectShareFile } from './check-share-safety.mjs';

const sourcePath = 'figma-account-switch/src/fixture.mjs';
const fakeToken = () => 'figd_' + 'A'.repeat(40);
const fakeEmail = () => ['private-user', 'mailbox.net'].join('@');

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'figma-share-safety-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  git(['init', '--quiet']);
  async function file(path, content) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  const commit = message => git(['-c', 'user.name=Share Safety Tests', '-c', 'user.email=tests@example.com', 'commit', '--quiet', '-m', message]);
  return { cwd, git, file, commit };
}

function assertRedacted(findings, secret) {
  assert.ok(findings.length > 0, 'Sensitive material must prevent sharing');
  assert.ok(!JSON.stringify(findings).includes(secret), 'Diagnostics must never include detected values');
  assert.ok(findings.every(item => typeof item.path === 'string' && typeof item.rule === 'string'), 'Findings should identify the file and rule');
}

test('share scan accepts example identities and runtime-generated credentials in source', () => {
  const source = "const identity = { email: 'a@example.com' };\nconst token = randomBytes(32).toString('hex');\n";
  assert.deepEqual(inspectShareFile(sourcePath, source), []);
  assert.deepEqual(inspectShareFile('README.md', 'For examples use a@example.com.\n'), []);
});

test('share scan detects credential formats and reports locations without exposing values', () => {
  const material = [
    fakeToken(),
    'Bearer ' + 'B'.repeat(48),
    JSON.stringify({ access_token: 'C'.repeat(48) }),
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' ') + '\n' + 'D'.repeat(48),
    'http://127.0.0.1:54321/#session=' + 'e'.repeat(64),
    fakeEmail()
  ];
  for (const value of material) {
    const findings = inspectShareFile(sourcePath, Buffer.from(value));
    assertRedacted(findings, value);
    assert.ok(findings.every(item => Number.isSafeInteger(item.line) && item.line >= 1), 'Text findings should identify a line');
  }
});

test('Git scan accepts a clean source repository', async t => {
  const f = await fixture(t);
  await f.file('README.md', 'Clean plugin documentation.\n');
  await f.file(sourcePath, 'export const value = 1;\n');
  const report = await checkGitShareSafety({ cwd: f.cwd });
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.historyCommits, 0);
});

test('Git scan rejects a forcibly staged credential file even when gitignore hides it', async t => {
  const f = await fixture(t);
  await f.file('.gitignore', 'auth.json\n');
  await f.file('auth.json', JSON.stringify({ token: fakeToken() }));
  f.git(['add', '-f', 'auth.json']);
  const report = await checkGitShareSafety({ cwd: f.cwd });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some(item => item.path === 'auth.json'));
  assert.ok(!JSON.stringify(report).includes(fakeToken()));
});

test('Git scan checks the staged blob after the working copy has been cleaned', async t => {
  const f = await fixture(t);
  await f.file(sourcePath, 'export const value = ' + JSON.stringify(fakeToken()) + ';\n');
  f.git(['add', sourcePath]);
  await f.file(sourcePath, 'export const value = 1;\n');
  const report = await checkGitShareSafety({ cwd: f.cwd });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some(item => item.path === sourcePath));
  assert.ok(!JSON.stringify(report).includes(fakeToken()));
});

test('Git scan checks committed history after a secret file was deleted', async t => {
  const f = await fixture(t);
  await f.file(sourcePath, 'export const value = ' + JSON.stringify(fakeToken()) + ';\n');
  f.git(['add', sourcePath]);
  f.commit('Add test fixture');
  f.git(['rm', '--quiet', sourcePath]);
  f.commit('Remove test fixture');
  const report = await checkGitShareSafety({ cwd: f.cwd });
  assert.equal(report.ok, false);
  assert.ok(report.historyCommits >= 1);
  assert.ok(report.findings.some(item => item.path === sourcePath));
  assert.ok(!JSON.stringify(report).includes(fakeToken()));
});

test('share-safety CLI refuses unsafe code without printing detected values', async t => {
  const f = await fixture(t);
  await f.file(sourcePath, 'export const value = ' + JSON.stringify(fakeToken()) + ';\n');
  const script = fileURLToPath(new URL('./check-share-safety.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd: f.cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'Unsafe code must cause a nonzero exit status');
  assert.ok(!(result.stdout + result.stderr).includes(fakeToken()), 'CLI output must remain redacted');
});

test('Git scan rejects unreviewed image assets and source symlinks', async t => {
  const f = await fixture(t);
  const assetPath = 'figma-account-switch/assets/profile.png';
  await f.file(assetPath, Buffer.from('unreviewed image fixture'));
  const imageReport = await checkGitShareSafety({ cwd: f.cwd });
  assert.equal(imageReport.ok, false);
  assert.ok(imageReport.findings.some(item => item.path === assetPath));
  await rm(join(f.cwd, assetPath));
  await f.file('README.md', 'Clean documentation.\n');
  await mkdir(dirname(join(f.cwd, sourcePath)), { recursive: true });
  await symlink(join(f.cwd, 'README.md'), join(f.cwd, sourcePath));
  const linkReport = await checkGitShareSafety({ cwd: f.cwd });
  assert.equal(linkReport.ok, false);
  assert.ok(linkReport.findings.some(item => item.path === sourcePath));
});
