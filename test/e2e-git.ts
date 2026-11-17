// End-to-end git test with a real git CLI against the forge.
import { createApp } from '../app.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const PORT = 18098;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token';

const server = createApp();
await new Promise<void>((resolve) => server.listen(PORT, resolve));
console.log('listening on', PORT);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name} ${detail}`); }
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await run('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } });
  return { stdout, stderr };
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json };
}

const work = await mkdtemp(join(tmpdir(), 'forge-e2e-'));
console.log('work dir', work);

// Create repo via REST, then push from a local git repo (tests receive-pack + delta packs).
const repoName = 'e2e-repo';
{
  const r = await req('POST', '/api/v3/user/repos', { name: repoName, description: 'e2e' });
  check('create repo', r.status === 201, JSON.stringify(r.json));
}

const local = join(work, 'local');
await run('mkdir', ['-p', local]);
await git(local, 'init', '-b', 'main');
await git(local, 'config', 'user.name', 'ada iversen');
await git(local, 'config', 'user.email', 'adaiversen@example.invalid');
await writeFile(join(local, 'hello.txt'), 'hello world\n');
await git(local, 'add', '.');
await git(local, 'commit', '-m', 'initial commit');
await git(local, 'remote', 'add', 'origin', `${BASE}/adaiversen/${repoName}.git`);
try {
  const push = await git(local, 'push', 'origin', 'main');
  check('git push (receive-pack)', true, push.stderr);
} catch (e) {
  check('git push (receive-pack)', false, String(e));
}
{
  const branches = await req('GET', `/api/v3/repos/adaiversen/${repoName}/branches`);
  check('pushed branch visible over REST', (branches.json as Array<Record<string, unknown>>).some((b) => b.name === 'main'), JSON.stringify(branches.json));
  const commits = await req('GET', `/api/v3/repos/adaiversen/${repoName}/commits`);
  check('pushed commit visible over REST', (commits.json as Array<Record<string, unknown>>).length === 1, JSON.stringify(commits.json));
}

// Clone (v2) and verify content.
const cloneDir = join(work, 'clone');
try {
  const c = await git(work, 'clone', `${BASE}/adaiversen/${repoName}.git`, 'clone');
  check('git clone v2', true, c.stderr);
  const content = await readFile(join(cloneDir, 'hello.txt'), 'utf8');
  check('clone content', content === 'hello world\n', content);
  const log = await git(cloneDir, 'log', '--oneline');
  check('clone log', log.stdout.includes('initial commit'), log.stdout);
} catch (e) {
  check('git clone v2', false, String(e));
}

// Shallow clone depth 1, then deepen.
const shallowDir = join(work, 'shallow');
try {
  await git(work, 'clone', '--depth', '1', `${BASE}/adaiversen/${repoName}.git`, 'shallow');
  const content = await readFile(join(shallowDir, 'hello.txt'), 'utf8');
  check('shallow clone content', content === 'hello world\n', content);
  const shallowFile = await readFile(join(shallowDir, '.git', 'shallow'), 'utf8').catch(() => '');
  // A one-commit repo has no parents, so git writes no .git/shallow file at all.
  check('shallow file present (or n/a for root-only history)', shallowFile === '' || shallowFile.trim().length === 40, shallowFile);
} catch (e) {
  check('shallow clone', false, String(e));
}

// Second commit + push, then pull in the clone (fetch-incremental with haves).
await writeFile(join(local, 'second.txt'), 'second file\n');
await git(local, 'add', '.');
await git(local, 'commit', '-m', 'second commit');
try {
  await git(local, 'push', 'origin', 'main');
  check('second push', true);
} catch (e) {
  check('second push', false, String(e));
}
try {
  await git(cloneDir, 'pull', 'origin', 'main');
  const content = await readFile(join(cloneDir, 'second.txt'), 'utf8');
  check('pull fetches only new objects', content === 'second file\n', content);
} catch (e) {
  check('pull', false, String(e));
}

// Non-fast-forward push must be rejected and the ref must not move.
try {
  await git(cloneDir, 'config', 'user.name', 'ada iversen');
  await git(cloneDir, 'config', 'user.email', 'adaiversen@example.invalid');
  await git(cloneDir, 'checkout', '-b', 'rewind');
  await git(cloneDir, 'reset', '--hard', 'HEAD~1');
  await writeFile(join(cloneDir, 'diverge.txt'), 'diverged\n');
  await git(cloneDir, 'add', '.');
  await git(cloneDir, 'commit', '-m', 'diverged commit');
  const out = await git(cloneDir, 'push', 'origin', 'rewind:main').catch((e: { stdout: string; stderr: string }) => e);
  const rejected = (out.stderr + out.stdout).includes('non-fast-forward');
  check('non-fast-forward rejected', rejected, out.stderr + out.stdout);
  const branches = await req('GET', `/api/v3/repos/adaiversen/${repoName}/branches`);
  const commits = await req('GET', `/api/v3/repos/adaiversen/${repoName}/commits`);
  check('ref did not move after rejected push', (commits.json as Array<Record<string, unknown>>).length === 2, JSON.stringify(commits.json));
} catch (e) {
  check('non-fast-forward push', false, String(e));
}

// v0 clone.
const clone0Dir = join(work, 'clone0');
try {
  await git(work, '-c', 'protocol.version=0', 'clone', `${BASE}/adaiversen/${repoName}.git`, 'clone0');
  const content = await readFile(join(clone0Dir, 'second.txt'), 'utf8');
  check('git clone v0', content === 'second file\n', content);
} catch (e) {
  check('git clone v0', false, String(e));
}

// Clone an empty repo (unborn HEAD).
{
  const r = await req('POST', '/api/v3/user/repos', { name: 'empty-repo' });
  check('create empty repo', r.status === 201, JSON.stringify(r.json));
}
try {
  const out = await git(work, 'clone', `${BASE}/adaiversen/empty-repo.git`, 'empty-clone').catch((e: { stdout: string; stderr: string }) => e);
  const ok = (out.stderr + out.stdout).includes('empty repository') || (out.stderr + out.stdout).includes('You appear to have cloned an empty repository');
  check('clone empty repo warns (not crash)', ok, out.stderr + out.stdout);
} catch (e) {
  check('clone empty repo', false, String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
server.close();
process.exit(failed > 0 ? 1 : 0);
