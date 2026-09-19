// Drives a real server process through the whole life of a connector:
// discovery → registration → /authorize page → SSH-style approval via the CLI →
// token → MCP tool call → refresh → restart → revoke.
import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 18808;
const BASE = `http://localhost:${PORT}`;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-mcp-e2e-'));
const env = {
  ...process.env,
  BOX_MCP_PORT: String(PORT),
  BOX_MCP_STATE_DIR: stateDir,
  BOX_MCP_PUBLIC_URL: BASE,
  BOX_MCP_REFRESH_GRACE: '2',
  BOX_MCP_INSTRUCTIONS_FILE: path.join(stateDir, 'CLAUDE.md')
};

let server: ChildProcess;

async function startServer() {
  server = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/cli.ts', 'serve'], { cwd: ROOT, env, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
}

async function stopServer() {
  server.kill('SIGTERM');
  await new Promise(r => server.once('exit', r));
}

function cli(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(path.join(ROOT, 'bin/box-mcp'), args, { env }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr })
    );
  });
}

const form = (data: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(data)
});

async function callBash(accessToken: string, args: Record<string, unknown>) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
  });
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);
  try {
    // Several boxes can be connected at once: the host has to be part of the identity.
    assert.equal(client.getServerVersion()?.name, `box-mcp-${os.hostname().split('.')[0]}`);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name), ['bash']);
    return (await client.callTool({ name: 'bash', arguments: args })) as { content: { text: string }[]; isError?: boolean };
  } finally {
    await client.close();
  }
}

const mcpStatus = async (token?: string) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  });

before(startServer);
after(async () => {
  await stopServer();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// Shared across the ordered steps below.
let clientId = '';
let clientSecret = '';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
let authCode = '';
let access = '';
let refresh = '';

test('discovery metadata points at this server', async () => {
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.authorization_endpoint, `${BASE}/authorize`);
  assert.equal(as.registration_endpoint, `${BASE}/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  const rs = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(rs.resource, `${BASE}/mcp`);
});

test('unauthenticated /mcp → 401 that tells the client where to log in', async () => {
  const r = await mcpStatus();
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /resource_metadata="http:\/\/localhost:18808\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await mcpStatus('not-a-real-token')).status, 401);
});

test('wrong Host header is refused', async () => {
  // fetch() won't let us forge Host, so go one level down.
  const status = await new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/', headers: { host: 'evil.example' } }, res => resolve(res.statusCode ?? 0)).on('error', reject);
  });
  assert.equal(status, 421);
});

test('registration: only Claude callbacks are accepted', async () => {
  const reg = (redirect_uris: string[]) =>
    fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude (e2e)', redirect_uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
    });
  assert.equal((await reg(['https://evil.example/cb'])).status, 400);
  assert.equal((await reg([CALLBACK, 'https://evil.example/cb'])).status, 400);

  const ok = await reg([CALLBACK]);
  assert.equal(ok.status, 201);
  const body = await ok.json();
  clientId = body.client_id;
  clientSecret = body.client_secret;
  assert.ok(clientId && clientSecret);
  assert.equal(body.client_secret_expires_at, 0, 'client secret must never expire');
});

test('/authorize shows a code; approval only happens through the CLI', async () => {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${BASE}/mcp`
  });

  // A redirect_uri that wasn't registered never reaches the code page.
  const evil = new URLSearchParams(q);
  evil.set('redirect_uri', 'https://evil.example/cb');
  assert.equal((await fetch(`${BASE}/authorize?${evil}`, { redirect: 'manual' })).status, 400);

  const page = await fetch(`${BASE}/authorize?${q}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  const html = await page.text();
  const rid = html.match(/const rid = "([^"]+)"/)?.[1];
  const userCode = html.match(/id="code">([A-Z0-9-]+)</)?.[1];
  assert.ok(rid && userCode, 'page contains rid and code');
  assert.match(userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const poll = async (r = rid) => (await fetch(`${BASE}/authorize/status?rid=${encodeURIComponent(r)}`)).json();
  assert.deepEqual(await poll(), { status: 'pending' });
  assert.deepEqual(await poll('guessed-rid'), { status: 'expired' });

  assert.match((await cli('pending')).out, new RegExp(userCode));
  const wrong = await cli('approve', 'AAAA-AAAA');
  assert.equal(wrong.code, 1);
  assert.deepEqual(await poll(), { status: 'pending' });

  // Codes are typed by hand: case and dashes don't matter.
  const approved = await cli('approve', userCode.toLowerCase().replace('-', ' '));
  assert.equal(approved.code, 0, approved.out);
  assert.match(approved.out, /Approved:/);

  const done = await poll();
  assert.equal(done.status, 'approved');
  const redirect = new URL(done.redirect);
  assert.equal(redirect.origin + redirect.pathname, CALLBACK);
  assert.equal(redirect.searchParams.get('state'), 'xyz');
  authCode = redirect.searchParams.get('code')!;
  assert.ok(authCode);

  assert.deepEqual(await poll(), { status: 'expired' }, 'the redirect is handed out once');
});

test('/token: PKCE enforced, code is single-use', async () => {
  const exchange = (code_verifier: string) =>
    fetch(`${BASE}/token`, form({ grant_type: 'authorization_code', code: authCode, code_verifier, redirect_uri: CALLBACK, client_id: clientId, client_secret: clientSecret }));

  const badPkce = await exchange('wrong-verifier-wrong-verifier-wrong-verifier-wrong');
  assert.equal(badPkce.status, 400);
  assert.equal((await badPkce.json()).error, 'invalid_grant');

  const noSecret = await fetch(`${BASE}/token`, form({ grant_type: 'authorization_code', code: authCode, code_verifier: verifier, client_id: clientId }));
  assert.equal(noSecret.status, 400);

  const ok = await exchange(verifier);
  assert.equal(ok.status, 200);
  const tokens = await ok.json();
  access = tokens.access_token;
  refresh = tokens.refresh_token;
  assert.ok(access && refresh);
  assert.equal(tokens.expires_in, 3600);

  assert.equal((await exchange(verifier)).status, 400, 'code cannot be replayed');
});

test('the bash tool works over MCP with the token', async () => {
  const r = await callBash(access, { command: 'echo "hello from $(whoami)"; exit 7', cwd: '/tmp' });
  assert.match(r.content[0].text, new RegExp(`hello from ${os.userInfo().username}\n\\[exit code 7`));
  assert.equal(r.isError, true);

  const audit = fs.readFileSync(path.join(stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.equal(audit.client, clientId);
  assert.ok(audit.grant);
});

test('the machine CLAUDE.md rides along in the tool description, live', async () => {
  const describe = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access}` } } });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    try {
      return (await client.listTools()).tools[0].description ?? '';
    } finally {
      await client.close();
    }
  };

  assert.doesNotMatch(await describe(), /machine-instructions/, 'no file → no section');

  fs.writeFileSync(env.BOX_MCP_INSTRUCTIONS_FILE, '# House rules\nAlways use the canary-7431 deploy script.\n');
  const withFile = await describe();
  assert.match(withFile, /<machine-instructions>\n# House rules\nAlways use the canary-7431 deploy script\.\n<\/machine-instructions>/);
  assert.match(withFile, /^Run a bash command/, 'behaviour notes still come first');

  fs.writeFileSync(env.BOX_MCP_INSTRUCTIONS_FILE, 'x'.repeat(9000));
  const long = await describe();
  assert.match(long, /truncated — read the rest with: cat /);
  assert.ok(long.length < 11_000);

  fs.rmSync(env.BOX_MCP_INSTRUCTIONS_FILE);
});

test('state on disk: private, and holds no usable secrets', async () => {
  const file = path.join(stateDir, 'state.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(access) && !raw.includes(refresh), 'only token hashes are stored');
});

test('refresh: concurrent refreshes both succeed, old token dies after the grace window', async () => {
  const doRefresh = (token: string) =>
    fetch(`${BASE}/token`, form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId, client_secret: clientSecret }));

  const [a, b] = await Promise.all([doRefresh(refresh), doRefresh(refresh)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const newer = await a.json();
  assert.notEqual(newer.refresh_token, refresh, 'refresh tokens rotate');

  await new Promise(r => setTimeout(r, 2500)); // BOX_MCP_REFRESH_GRACE=2
  assert.equal((await doRefresh(refresh)).status, 400, 'rotated-out token is dead after grace');
  const again = await doRefresh(newer.refresh_token);
  assert.equal(again.status, 200, 'the current one still works');

  access = newer.access_token;
  assert.equal((await mcpStatus(access)).status, 200);
});

test('logins survive a server restart', async () => {
  await stopServer();
  await startServer();
  assert.equal((await mcpStatus(access)).status, 200);
  assert.match((await cli('grants')).out, /Claude \(e2e\)/);
});

test('revoke kills access immediately', async () => {
  const r = await cli('revoke', '--all');
  assert.match(r.out, /Revoked 1 login/);
  assert.equal((await mcpStatus(access)).status, 401);
  assert.match((await cli('grants')).out, /No active logins/);
});
