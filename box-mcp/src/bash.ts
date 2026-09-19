import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUDIT_LOG,
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_OUTPUT_BYTES,
  BASH_MAX_OUTPUT_CHARS,
  BASH_MAX_TIMEOUT_MS,
  INSTRUCTIONS_FILE,
  OUTPUT_DIR,
  SHELL_ENV_FILE
} from './config.ts';

export type BashArgs = {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  run_in_background?: boolean;
};

export type BashContext = {
  /** Who is calling, for the audit log. */
  grantId?: string;
  clientId?: string;
  /** Aborts when the MCP client cancels the request or disconnects. */
  signal?: AbortSignal;
};

export type BashResult = { text: string; isError: boolean };

const BASE_DESCRIPTION = `Run a bash command on the user's remote dev box (${os.hostname()}) as user "${os.userInfo().username}", who has passwordless sudo.

How it behaves:
- Each call is a fresh non-interactive \`bash -c\` with no TTY and no stdin. Nothing carries over between calls: no working directory, no env vars, no shell functions. Pass \`cwd\` (or \`cd dir && …\`) every time; it defaults to the home directory.
- PATH matches the user's interactive shell (Homebrew, asdf runtimes such as node/bun, ~/.local/bin) and ~/.bashrc.local is loaded.
- stdout and stderr are returned interleaved, followed by the exit code. Output beyond ${BASH_MAX_OUTPUT_CHARS.toLocaleString('en-US')} characters is cut from the middle and the full text is saved to a file whose path is given — read parts of it with head/tail/grep/sed.
- \`timeout_ms\` defaults to ${BASH_DEFAULT_TIMEOUT_MS / 1000}s (max ${BASH_MAX_TIMEOUT_MS / 1000}s). On timeout the whole process group is killed.
- For anything long-running (builds, installs, dev servers, watchers) set \`run_in_background: true\`: the command starts as a transient systemd user unit and the call returns at once with the unit name and a log file. Follow up with ordinary commands: \`tail -n 50 <log>\`, \`systemctl --user is-active <unit>\`, \`systemctl --user stop <unit>\`.
- Interactive programs (editors, pagers, prompts, \`sudo\` asking for a password) cannot work. Use non-interactive flags (-y, --no-pager, …).
- To edit files use heredocs, \`sed -i\`, \`patch\`, or a short python/node script.

This is a real machine with real data: be careful with destructive commands.`;

/**
 * Tool description = how the tool behaves + a pointer to the machine's own
 * CLAUDE.md. The description is the one piece of server text every MCP client
 * puts in front of the model, so that's where the "read this first" lives. Only
 * a pointer, not the contents: always current, and free in conversations that
 * never touch the box.
 */
export function bashToolDescription(): string {
  if (!fs.existsSync(INSTRUCTIONS_FILE)) return BASE_DESCRIPTION;
  const home = os.homedir();
  const shown = INSTRUCTIONS_FILE.startsWith(home + path.sep) ? `~${INSTRUCTIONS_FILE.slice(home.length)}` : INSTRUCTIONS_FILE;
  return `${BASE_DESCRIPTION}

Before your first command in a conversation, read the owner's standing instructions for this machine with \`cat ${shown}\`, and follow them. Once per conversation is enough. Parts written for Claude Code itself (skills, hooks, slash commands) don't apply to you. Likewise, before working inside a project directory, read its own CLAUDE.md if it has one.`;
}

const expandHome = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

function shellEnv(): NodeJS.ProcessEnv {
  return { ...process.env, BASH_ENV: SHELL_ENV_FILE, TERM: 'dumb', NO_COLOR: '1' };
}

function audit(entry: Record<string, unknown>) {
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('audit log write failed:', err);
  }
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/** Middle-truncates `text`, spilling the full version to a file. */
function truncate(text: string, id: string, spilledTo?: string): string {
  if (text.length <= BASH_MAX_OUTPUT_CHARS && !spilledTo) return text;
  let file = spilledTo;
  if (!file) {
    file = path.join(OUTPUT_DIR, `${id}.log`);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
  }
  const headLen = Math.floor(BASH_MAX_OUTPUT_CHARS / 3);
  const tailLen = BASH_MAX_OUTPUT_CHARS - headLen;
  const omitted = Math.max(0, text.length - headLen - tailLen);
  return (
    text.slice(0, headLen) +
    `\n\n[… ${omitted.toLocaleString('en-US')}+ characters omitted — full output saved to ${file} …]\n\n` +
    text.slice(-tailLen)
  );
}

export async function runBash(args: BashArgs, ctx: BashContext = {}): Promise<BashResult> {
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
  const cwd = path.resolve(expandHome(args.cwd?.trim() || '~'));
  const who = { grant: ctx.grantId, client: ctx.clientId };

  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    audit({ id, ...who, command: args.command, cwd, error: 'bad cwd' });
    return { text: `cwd does not exist or is not a directory: ${cwd}`, isError: true };
  }

  if (args.run_in_background) {
    const result = await startBackground(id, args.command, cwd);
    audit({ id, ...who, command: args.command, cwd, background: true, unit: result.unit, error: result.error });
    return { text: result.text, isError: Boolean(result.error) };
  }

  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS, 1000), BASH_MAX_TIMEOUT_MS);
  const started = Date.now();

  return new Promise<BashResult>(resolve => {
    const child = spawn('/bin/bash', ['-c', args.command], {
      cwd,
      env: shellEnv(),
      detached: true, // own process group, so timeouts kill grandchildren too
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Keep everything in memory up to IN_MEMORY_LIMIT; past that, stream to a
    // spill file and keep only the head (already held) and a rolling tail.
    const IN_MEMORY_LIMIT = 1024 * 1024;
    const TAIL_KEEP = 256 * 1024;
    let head: Buffer[] = [];
    let tail: Buffer[] = [];
    let tailBytes = 0;
    let totalBytes = 0;
    let spill: fs.WriteStream | undefined;
    let spillPath: string | undefined;
    let note = '';
    let finished = false;

    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (!spill && totalBytes <= IN_MEMORY_LIMIT) {
        head.push(chunk);
        return;
      }
      if (!spill) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
        spillPath = path.join(OUTPUT_DIR, `${id}.log`);
        spill = fs.createWriteStream(spillPath, { mode: 0o600 });
        for (const b of head) spill.write(b);
      }
      spill.write(chunk);
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tail.length > 1 && tailBytes - tail[0].length >= TAIL_KEEP) tailBytes -= tail.shift()!.length;
      if (totalBytes > BASH_MAX_OUTPUT_BYTES && !note) {
        note = `Killed: output exceeded ${BASH_MAX_OUTPUT_BYTES / 1024 / 1024} MB.`;
        killGroup(child.pid!, 'SIGKILL');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      note = `Timed out after ${timeoutMs / 1000}s — process group killed. Use run_in_background for long-running commands.`;
      killGroup(child.pid!, 'SIGTERM');
      setTimeout(() => killGroup(child.pid!, 'SIGKILL'), 2000).unref();
    }, timeoutMs);

    const onAbort = () => {
      note = 'Cancelled by client — process group killed.';
      killGroup(child.pid!, 'SIGTERM');
      setTimeout(() => killGroup(child.pid!, 'SIGKILL'), 2000).unref();
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      spill?.end();

      const ms = Date.now() - started;
      let output = Buffer.concat(head).toString('utf8');
      if (spill) output += '\n' + Buffer.concat(tail).toString('utf8');
      output = truncate(output.replace(/\s+$/, ''), id, spillPath);

      const status = spawnError
        ? `failed to start: ${spawnError.message}`
        : signal
          ? `killed by ${signal}`
          : `exit code ${code}`;
      const footer = `[${status} · ${(ms / 1000).toFixed(1)}s]`;
      const text = [output || '(no output)', note, footer].filter(Boolean).join('\n');

      audit({ id, ...who, command: args.command, cwd, exit: code, signal, ms, bytes: totalBytes, note: note || undefined });
      resolve({ text, isError: Boolean(spawnError) || code !== 0 });
    };

    child.on('error', err => finish(null, null, err));
    // 'close' waits for the pipes; a command that leaves a daemon holding stdout
    // (`foo &`) would hang forever, so settle shortly after 'exit' regardless.
    child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 250));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function run(file: string, argv: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise(resolve => {
    execFile(file, argv, { env: shellEnv() }, (err, _stdout, stderr) => resolve({ ok: !err, stderr: String(stderr || err?.message || '') }));
  });
}

async function startBackground(id: string, command: string, cwd: string): Promise<{ text: string; unit?: string; error?: string }> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  const log = path.join(OUTPUT_DIR, `${id}.log`);
  const unit = `box-mcp-job-${id}`;
  fs.writeFileSync(log, '', { mode: 0o600 });

  // A transient user unit lives outside this service's cgroup, so it survives
  // box-mcp restarts and can be managed with plain systemctl.
  const viaSystemd = await run('systemd-run', [
    '--user',
    '--quiet',
    '--collect',
    `--unit=${unit}`,
    `--description=box-mcp background job: ${command.slice(0, 80)}`,
    `--working-directory=${cwd}`,
    `--setenv=BASH_ENV=${SHELL_ENV_FILE}`,
    `--property=StandardOutput=append:${log}`,
    `--property=StandardError=append:${log}`,
    '/bin/bash',
    '-c',
    command
  ]);

  if (viaSystemd.ok) {
    return {
      unit,
      text: [
        `Started in background as systemd user unit ${unit}.service`,
        `Log (stdout+stderr): ${log}`,
        `Check:  systemctl --user is-active ${unit}; tail -n 50 ${log}`,
        `Stop:   systemctl --user stop ${unit}`
      ].join('\n')
    };
  }

  // No user manager available (e.g. lingering disabled): plain detached process.
  try {
    const fd = fs.openSync(log, 'a');
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: shellEnv(), detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    child.unref();
    return {
      text: [
        `Started in background as a detached process, pid ${child.pid} (systemd-run unavailable: ${viaSystemd.stderr.trim()})`,
        `Log (stdout+stderr): ${log}`,
        `Check:  kill -0 ${child.pid} && echo running; tail -n 50 ${log}`,
        `Stop:   kill -- -${child.pid}`
      ].join('\n')
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Failed to start background command: ${message}`, error: message };
  }
}
