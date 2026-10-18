import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * bin/polaris.mjs 的命令行契约（评审 P1-8 / P2-12）。
 * 只跑不写盘的路径：--dry-run / 空 profile 回滚，避免测试碰真实宿主目录。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'polaris.mjs');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function polaris(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('polaris help lists every command', () => {
  const r = polaris(['help']);
  assert.equal(r.code, 0);
  for (const cmd of ['install', 'doctor', 'token', 'pack', 'rollback', 'release', 'version']) {
    assert.ok(r.out.includes('polaris ' + cmd), 'help must document ' + cmd);
  }
});

test('polaris version prints the package version', () => {
  const r = polaris(['version']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), pkg.version);
});

test('polaris pack --dry-run lists the manifest without writing a tarball', () => {
  const r = polaris(['pack', '--dry-run']);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('pack --dry-run  polaris-toolkit@' + pkg.version));
  assert.ok(r.out.includes('files   '));
  assert.ok(r.out.includes('polaris-toolkit-' + pkg.version + '.tgz'));
  assert.ok(r.out.includes(path.join('lib', 'index.js')), 'the manifest must include lib/index.js');
  assert.ok(!fs.existsSync(path.join(root, 'dist')), 'dry run must not create dist/');
});

test('polaris rollback reports a missing profile backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-profile-'));
  const r = polaris(['rollback', '--profile', dir]);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('没有找到备份'), 'expected a no-backup message, got: ' + r.err);
});

test('polaris release --dry-run runs the gates without tagging', () => {
  const r = polaris(['release', '--dry-run', '--allow-dirty', '--skip-tests']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('release check ok'));
  assert.ok(r.out.includes('v' + pkg.version));
  assert.ok(r.out.includes('no tag created'));
});
