import fs from 'node:fs';
import net from 'node:net';
import express from 'express';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { ADMIN_SOCKET, BASH_MAX_TIMEOUT_MS, HOST_LABEL, PORT, waitForPublicUrl } from './config.ts';
import { BASH_TOOL_DESCRIPTION, runBash } from './bash.ts';
import { BoxOAuthProvider, formatUserCode } from './oauth.ts';
import { now, Store } from './store.ts';

const publicUrl = await waitForPublicUrl();
const mcpUrl = new URL('/mcp', publicUrl);
const store = new Store();
const provider = new BoxOAuthProvider(store, mcpUrl);

// --- MCP: one tool --------------------------------------------------------------

function buildMcpServer(): McpServer {
  // The host is part of the identity: with several boxes connected, Claude has to tell them apart.
  const server = new McpServer({ name: `box-mcp-${HOST_LABEL}`, title: `Shell on ${HOST_LABEL}`, version: '0.1.0' });
  server.registerTool(
    'bash',
    {
      title: `Run bash on ${HOST_LABEL}`,
      description: BASH_TOOL_DESCRIPTION,
      inputSchema: {
        command: z.string().min(1).describe('The bash command line to run.'),
        cwd: z.string().optional().describe('Working directory (absolute, or starting with ~). Defaults to the home directory.'),
        timeout_ms: z.number().int().positive().max(BASH_MAX_TIMEOUT_MS).optional().describe('Kill the command after this many milliseconds.'),
        run_in_background: z.boolean().optional().describe('Start detached and return immediately with a unit name and log path.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => {
      // Keep the response stream warm during long commands so proxies don't drop it.
      const progressToken = extra._meta?.progressToken;
      let ticks = 0;
      const keepalive =
        progressToken === undefined
          ? undefined
          : setInterval(() => {
              extra
                .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++ticks, message: 'still running' } })
                .catch(() => {});
            }, 15_000);
      try {
        const result = await runBash(args, {
          grantId: extra.authInfo?.extra?.grantId as string | undefined,
          clientId: extra.authInfo?.clientId,
          signal: extra.signal
        });
        return { content: [{ type: 'text', text: result.text }], isError: result.isError };
      } finally {
        clearInterval(keepalive);
      }
    }
  );
  return server;
}

// --- HTTP -----------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// Tailscale Funnel/serve proxies from loopback; trust its X-Forwarded-For for req.ip and rate limiting.
app.set('trust proxy', 'loopback');

// Only answer for our own names (blocks DNS-rebinding against the localhost listener).
const allowedHosts = new Set([publicUrl.host, `localhost:${PORT}`, `127.0.0.1:${PORT}`]);
app.use((req, res, next) => {
  if (allowedHosts.has(req.headers.host ?? '')) return next();
  res.status(421).json({ error: 'misdirected_request' });
});

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: publicUrl,
    resourceServerUrl: mcpUrl,
    resourceName: `box-mcp (${HOST_LABEL})`,
    // Claude registers once and keeps that client for the life of the connector;
    // an expiring secret would force a relogin regardless of token lifetimes.
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 }
  })
);

app.get('/authorize/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(provider.poll(String(req.query.rid ?? '')));
});

const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

// Stateless Streamable HTTP: a fresh server+transport per request, so restarts and
// multiple Claude devices need no session bookkeeping.
app.post('/mcp', bearer, express.json({ limit: '4mb' }), async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('mcp request failed:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});
app.all('/mcp', bearer, (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});

app.get('/', (_req, res) => {
  res.type('text').send('box-mcp\n');
});

// --- admin socket: `box-mcp approve …` ------------------------------------------
// Lives in a 0700 directory, so reaching it requires a shell as this user — which
// is exactly the credential the login flow asks for.

type AdminRequest = { cmd: string; code?: string; id?: string };

function handleAdmin(req: AdminRequest): unknown {
  switch (req.cmd) {
    case 'approve':
    case 'deny': {
      const p = provider.decide(req.code ?? '', req.cmd === 'approve' ? 'approved' : 'denied');
      if (!p) return { ok: false, error: 'No pending request with that code (codes expire after 2 minutes).' };
      console.log(`login ${req.cmd === 'approve' ? 'approved' : 'denied'}: code=${formatUserCode(p.userCode)} client=${p.client.client_name ?? p.client.client_id} ip=${p.ip}`);
      return { ok: true, request: describe(p) };
    }
    case 'pending':
      return { ok: true, pending: provider.listPending().map(describe) };
    case 'grants':
      return { ok: true, now: now(), grants: Object.values(store.state.grants) };
    case 'revoke': {
      if (req.id === '--all') return { ok: true, revoked: store.revokeAll() };
      return store.revokeGrant(req.id ?? '') ? { ok: true, revoked: 1 } : { ok: false, error: `No grant with id ${req.id}` };
    }
    case 'info':
      return { ok: true, mcpUrl: mcpUrl.href, port: PORT };
    default:
      return { ok: false, error: `Unknown command: ${req.cmd}` };
  }
}

function describe(p: ReturnType<typeof provider.listPending>[number]) {
  return {
    code: formatUserCode(p.userCode),
    client: p.client.client_name ?? p.client.client_id,
    redirect: new URL(p.params.redirectUri).origin,
    ip: p.ip,
    userAgent: p.userAgent,
    ageSeconds: now() - p.createdAt
  };
}

fs.rmSync(ADMIN_SOCKET, { force: true });
const admin = net.createServer(socket => {
  let buf = '';
  socket.on('data', chunk => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    let reply: unknown;
    try {
      reply = handleAdmin(JSON.parse(buf.slice(0, nl)));
    } catch (err) {
      reply = { ok: false, error: String(err) };
    }
    socket.end(JSON.stringify(reply) + '\n');
  });
  socket.on('error', () => {});
});
admin.listen(ADMIN_SOCKET, () => fs.chmodSync(ADMIN_SOCKET, 0o600));

// --- go -------------------------------------------------------------------------

const http = app.listen(PORT, '127.0.0.1', () => {
  console.log(`box-mcp listening on 127.0.0.1:${PORT}`);
  console.log(`connector URL: ${mcpUrl.href}`);
});
// Commands may legitimately run for minutes.
http.requestTimeout = 0;
http.headersTimeout = 60_000;

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    store.save();
    admin.close();
    fs.rmSync(ADMIN_SOCKET, { force: true });
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
