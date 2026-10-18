#!/usr/bin/env node
/**
 * 仓库卫生检查（评审 P1-9）：语法 + 编码 + 清单一致性，由 _test/all.mjs 先跑。
 *
 * 检查的都是改完就忘的东西：BOM、行尾约定、package.json 的 files/peers/scripts、
 * lockfile 与 CI 是否同一条命令、有没有 %SystemDrive% 这类误生成的垃圾目录。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (msg) => failures.push(msg);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '_scratch') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const all = walk(root);
const hasBom = (abs) => {
  const b = fs.readFileSync(abs);
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
};

// 1) JS/MJS 语法
for (const dir of ['lib', 'bin', '_test', 'test']) {
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) continue;
  for (const p of walk(base).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    if (r.status !== 0) fail('syntax: ' + path.relative(root, p) + ' :: ' + (r.stderr || '').split(NL).slice(0, 3).join(' | '));
  }
}

// 2) 编码：install/*.ps1 必须带 BOM，其余文本不得带 BOM
for (const rel of ['install/install.ps1', 'install/uninstall.ps1']) {
  if (!fs.existsSync(path.join(root, rel))) fail(rel + ' is missing');
  else if (!hasBom(path.join(root, rel))) fail(rel + ' must start with a UTF-8 BOM (PowerShell 5.1 reads it as GBK otherwise)');
}
for (const ext of ['.js', '.mjs', '.json', '.yml', '.yaml', '.md']) {
  for (const abs of all.filter((f) => f.endsWith(ext))) {
    const rel = path.relative(root, abs);
    if (rel === 'pnpm-lock.yaml') continue;
    if (hasBom(abs)) fail(rel + ' must not start with a BOM');
  }
}

// 3) package.json 清单一致性
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.dependencies !== undefined) fail('package.json must not declare runtime dependencies (host packages are peers)');
for (const peer of ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']) {
  if (pkg.peerDependencies === undefined || pkg.peerDependencies[peer] === undefined) fail('peerDependencies is missing ' + peer);
  if (pkg.devDependencies === undefined || pkg.devDependencies[peer] === undefined) fail('devDependencies is missing ' + peer + ' (tests need a local copy)');
}
for (const entry of pkg.files || []) {
  if (!fs.existsSync(path.join(root, entry))) fail('package.json files[] entry does not exist: ' + entry);
}
for (const script of ['test', 'lint', 'test:coverage', 'doctor']) {
  if (pkg.scripts === undefined || pkg.scripts[script] === undefined) fail('package.json scripts is missing ' + script);
}

// 4) lockfile 与 CI 必须一致
const lockPath = path.join(root, 'pnpm-lock.yaml');
if (!fs.existsSync(lockPath)) fail('pnpm-lock.yaml is missing (CI installs with --frozen-lockfile)');
else if (!fs.readFileSync(lockPath, 'utf8').includes('@deepseek-ai/schemastery')) fail('pnpm-lock.yaml does not pin @deepseek-ai/schemastery');
const ciPath = path.join(root, '.github/workflows/ci.yml');
const ci = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
for (const needle of ['pnpm install --frozen-lockfile', 'pnpm test', 'test:coverage']) {
  if (!ci.includes(needle)) fail('.github/workflows/ci.yml is missing: ' + needle);
}

// 5) 行尾约定（见 AGENTS.md）；CRLF 只对 Windows 工作副本要求：仓库里以 LF 存储，
//    Linux/macOS 检出是 LF，不能因此判失败。
if (process.platform === 'win32') {
  for (const rel of ['README.md', 'lib/features/steward/http.js']) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !fs.readFileSync(abs, 'utf8').includes(CR + NL)) fail(rel + ' must keep CRLF line endings');
  }
}

// 6) 误生成的垃圾目录
for (const name of ['%SystemDrive%', 'undefined']) {
  if (fs.existsSync(path.join(root, name))) fail('stray directory in repo root: ' + name);
}

if (failures.length > 0) {
  console.error('lint: ' + failures.length + ' problem(s)');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('lint ok (scanned ' + all.length + ' files)');
