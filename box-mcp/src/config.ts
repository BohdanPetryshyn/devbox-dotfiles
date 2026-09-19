import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHELL_ENV_FILE = path.join(ROOT_DIR, 'shell-env.sh');

export const PORT = Number(process.env.BOX_MCP_PORT ?? 8808);
export const STATE_DIR = process.env.BOX_MCP_STATE_DIR ?? path.join(os.homedir(), '.local', 'state', 'box-mcp');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const ADMIN_SOCKET = path.join(STATE_DIR, 'admin.sock');
export const AUDIT_LOG = path.join(STATE_DIR, 'audit.jsonl');
export const OUTPUT_DIR = path.join(STATE_DIR, 'out');

/** Only these OAuth callbacks may register — i.e. only Claude can start a login. */
export const ALLOWED_REDIRECT_URIS = (
  process.env.BOX_MCP_REDIRECT_URIS ?? 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// --- OAuth lifetimes (seconds) ------------------------------------------------
export const ACCESS_TOKEN_TTL = 1 * HOUR;
/** Sliding: every refresh pushes the grant's expiry out again. */
export const REFRESH_TOKEN_TTL = 90 * DAY;
/** A rotated-out refresh token keeps working this long, so concurrent refreshes don't race into a relogin. */
export const REFRESH_GRACE = Number(process.env.BOX_MCP_REFRESH_GRACE ?? 60);
export const AUTH_CODE_TTL = 5 * MINUTE;
/** How long the code on the /authorize page can be approved. */
export const PENDING_TTL = 2 * MINUTE;
export const MAX_PENDING = 20;

// --- bash tool ------------------------------------------------------------------
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
// Measured: Anthropic's connector path drops a tool call at ~295 s no matter what
// the server does, and some clients stop waiting sooner. Stay clearly under it —
// anything longer belongs in run_in_background.
export const BASH_MAX_TIMEOUT_MS = 240_000;
export const BASH_MAX_OUTPUT_CHARS = 30_000;
/** Hard cap on what a single foreground command may write before it is killed. */
export const BASH_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/**
 * Standing instructions for whoever drives the shell. The tool description tells
 * the model to read this file before its first command in a conversation.
 * Defaults to the user's global Claude Code instructions.
 */
export const INSTRUCTIONS_FILE = process.env.BOX_MCP_INSTRUCTIONS_FILE ?? path.join(os.homedir(), '.claude', 'CLAUDE.md');

/** Short host name used in the `ssh <host> box-mcp approve …` hint. */
export const HOST_LABEL = process.env.BOX_MCP_HOST_LABEL ?? os.hostname().split('.')[0];

/**
 * Public origin of this server. Defaults to the machine's Tailscale Funnel name
 * so nothing machine-specific has to live in the (public) repo.
 */
export function resolvePublicUrl(): URL {
  const fromEnv = process.env.BOX_MCP_PUBLIC_URL;
  if (fromEnv) return new URL(fromEnv);
  try {
    const status = JSON.parse(execFileSync('tailscale', ['status', '--json', '--peers=false'], { encoding: 'utf8' }));
    const dnsName: string = status?.Self?.DNSName ?? '';
    if (dnsName) return new URL(`https://${dnsName.replace(/\.$/, '')}`);
  } catch {
    // fall through
  }
  throw new Error('Cannot determine public URL: set BOX_MCP_PUBLIC_URL or bring Tailscale up.');
}

/** At boot the service can start before tailscaled has its name; wait a little rather than crash-loop. */
export async function waitForPublicUrl(timeoutMs = 90_000): Promise<URL> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return resolvePublicUrl();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
