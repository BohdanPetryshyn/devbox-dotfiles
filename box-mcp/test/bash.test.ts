import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-mcp-bash-'));
process.env.BOX_MCP_STATE_DIR = stateDir;
fs.mkdirSync(stateDir, { recursive: true });

let runBash: typeof import('../src/bash.ts').runBash;
before(async () => ({ runBash } = await import('../src/bash.ts')));
after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

test('returns interleaved output and the exit code', async () => {
  const r = await runBash({ command: 'echo out; echo err >&2; exit 3' });
  assert.match(r.text, /out\nerr\n\[exit code 3/);
  assert.equal(r.isError, true);
});

test('success is not an error; empty output is labelled', async () => {
  const r = await runBash({ command: 'true' });
  assert.match(r.text, /^\(no output\)\n\[exit code 0/);
  assert.equal(r.isError, false);
});

test('cwd: defaults to home, accepts ~, rejects missing dirs', async () => {
  assert.match((await runBash({ command: 'pwd' })).text, new RegExp(`^${os.homedir()}\n`));
  assert.match((await runBash({ command: 'pwd', cwd: '/tmp' })).text, /^\/tmp\n/);
  assert.match((await runBash({ command: 'pwd', cwd: '~/box-mcp' })).text, new RegExp(`^${os.homedir()}/box-mcp\n`));
  const bad = await runBash({ command: 'pwd', cwd: '/definitely/not/here' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /cwd does not exist/);
});

test('no state carries over between calls', async () => {
  await runBash({ command: 'cd /tmp; export FOO=bar' });
  assert.match((await runBash({ command: 'echo "[$FOO]"; pwd' })).text, new RegExp(`^\\[\\]\n${os.homedir()}\n`));
});

test('shell-env.sh gives the interactive PATH (node, brew) without a login shell', async () => {
  const r = await runBash({ command: 'command -v node && node -v && command -v brew' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /\.asdf\/shims\/node/);
});

test('timeout kills the whole process group', async () => {
  const marker = `boxmcp-test-${process.pid}`;
  const started = Date.now();
  const r = await runBash({ command: `sleep 301 & exec -a ${marker} sleep 300`, timeout_ms: 1000 });
  assert.ok(Date.now() - started < 5000);
  assert.match(r.text, /Timed out after 1s/);
  assert.equal(r.isError, true);
  await new Promise(res => setTimeout(res, 300));
  // [b]racket trick: keeps pgrep from matching the shell that runs it.
  assert.equal(execSync(`pgrep -f '[b]${marker.slice(1)}' || true; pgrep -f '[s]leep 301' || true`, { encoding: 'utf8' }).trim(), '');
});

test('a daemon holding stdout does not hang the call', async () => {
  const started = Date.now();
  const r = await runBash({ command: 'sleep 4 & echo started' });
  assert.ok(Date.now() - started < 2000, 'returned promptly');
  assert.match(r.text, /^started\n\[exit code 0/);
});

test('long output is cut from the middle and spilled to a file', async () => {
  const r = await runBash({ command: 'seq 1 20000' });
  assert.ok(r.text.length < 32_000);
  assert.match(r.text, /^1\n2\n/);
  assert.match(r.text, /19999\n20000\n\[exit code 0/);
  const file = r.text.match(/full output saved to (\S+)/)?.[1];
  assert.ok(file && fs.existsSync(file));
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 20000);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('output past the in-memory limit streams to the spill file', async () => {
  const r = await runBash({ command: 'head -c 3000000 /dev/zero | tr "\\0" x; echo; echo THE-END' });
  assert.match(r.text, /THE-END\n\[exit code 0/);
  const file = r.text.match(/full output saved to (\S+)/)?.[1];
  assert.ok(file);
  assert.ok(fs.statSync(file).size >= 3_000_000);
});

test('abort signal cancels the command', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const started = Date.now();
  const r = await runBash({ command: 'sleep 30' }, { signal: ac.signal });
  assert.ok(Date.now() - started < 4000);
  assert.match(r.text, /Cancelled by client/);
});

test('run_in_background returns at once and logs to a file', async () => {
  const bg = await runBash({ command: 'echo bg-hello; pwd; command -v node; sleep 1; echo bg-done', cwd: '/tmp', run_in_background: true });
  assert.equal(bg.isError, false, bg.text);
  const log = bg.text.match(/Log \(stdout\+stderr\): (\S+)/)?.[1];
  assert.ok(log);
  await new Promise(res => setTimeout(res, 2500));
  const out = fs.readFileSync(log, 'utf8');
  assert.match(out, /bg-hello\n\/tmp\n.*node\nbg-done/s, `${bg.text}\n---\n${out}`);
});

test('every call lands in the audit log', async () => {
  await runBash({ command: 'echo audit-me' }, { grantId: 'g1', clientId: 'c1' });
  const lines = fs.readFileSync(path.join(stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const last = lines.at(-1);
  assert.equal(last.command, 'echo audit-me');
  assert.equal(last.grant, 'g1');
  assert.equal(last.exit, 0);
});
