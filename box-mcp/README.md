# box-mcp

Remote bash for Claude chat and Cowork. A single-tool MCP server (`bash`) that
claude.ai reaches over Tailscale Funnel, guarded by a self-hosted OAuth server
whose only login method is **running a command over SSH**.

```
claude.ai ──HTTPS──▶ Tailscale Funnel :443 ──▶ 127.0.0.1:8808  box-mcp
                                                 ├─ /register /authorize /token /revoke   OAuth 2.1 + PKCE
                                                 ├─ /mcp                                   Streamable HTTP, bearer-only
                                                 └─ ~/.local/state/box-mcp/admin.sock  ◀── box-mcp approve <CODE>
```

> This hands a shell with passwordless sudo to whatever holds a valid token.
> Read [Security](#security) before turning it on.

## Set up

`bootstrap.sh` only installs it. Nothing runs and nothing is reachable until you
opt in, on the box, with Tailscale connected:

```sh
box-mcp expose
```

That one command lets your user manage Tailscale Funnel (`sudo`, once), enables
systemd lingering, starts the service, opens Funnel on :443 → `127.0.0.1:8808`,
and prints the connector URL. The first time Funnel is used on a tailnet it
prints a link for the tailnet admin to enable Funnel + HTTPS certificates, waits,
and carries on by itself. It refuses to touch :443 if Tailscale is already
serving something else there. Safe to rerun.

Then in Claude: **Settings → Connectors → Add custom connector**, paste the URL,
and click **Connect**. The page that opens shows a one-time code and the exact
`ssh … box-mcp approve <CODE>` command to run; once you do, it returns to Claude
by itself. That one login covers every device on the Claude account (web,
desktop, mobile, Cowork) and lasts as long as the connector is used at least
once every 90 days.

More than one box? Run `expose` on each and add one connector per box — the
server identifies itself as `box-mcp-<hostname>`, so Claude can tell them apart.

## CLI

```
box-mcp expose               turn it on (service + Funnel), print the connector URL
box-mcp unexpose [--revoke]  turn it off; --revoke also logs every connector out
box-mcp status               running? public? how many logins?

box-mcp approve <CODE>       approve the login showing CODE in your browser
box-mcp deny <CODE>          reject it
box-mcp pending              logins waiting for approval
box-mcp grants               active logins
box-mcp revoke <id|--all>    log a connector out
box-mcp url                  connector URL
```

`unexpose` keeps logins by default, so a later `expose` resumes without a new
approval.

## The `bash` tool

`bash({ command, cwd?, timeout_ms?, run_in_background? })`

- Fresh `bash -c` per call — no TTY, no stdin, **no state between calls**; `cwd`
  defaults to `~`.
- [`shell-env.sh`](shell-env.sh) is loaded first (via `BASH_ENV`), giving
  commands the same PATH as an interactive shell plus `~/.bashrc.local`. Edit it
  to change what remote commands see.
- stdout+stderr interleaved, then `[exit code N · 1.2s]`. Output over 30k
  characters is cut from the middle; the full text goes to
  `~/.local/state/box-mcp/out/`.
- Timeout 120 s by default, 600 s max; the whole process group is killed.
- `run_in_background` starts a transient systemd user unit
  (`box-mcp-job-<id>`) that outlives server restarts and logs to a file; manage
  it with ordinary `systemctl --user` / `tail`.
- Every call is appended to `~/.local/state/box-mcp/audit.jsonl`.

### Your CLAUDE.md comes along

The tool description ends with the contents of `~/.claude/CLAUDE.md` (first 8k
characters), so a Claude chat knows the machine's conventions before its first
command — the same standing instructions Claude Code gets on the box. It's read
fresh whenever the client lists tools; clients cache that list, so an edit shows
up in new conversations after the connector next refreshes. The description also
tells Claude to read a project's own `CLAUDE.md` before working in it. Point
`BOX_MCP_INSTRUCTIONS_FILE` elsewhere to give chat different instructions, or at
a missing file to turn this off.

## Security

- **Login = SSH access.** `/authorize` never asks for a secret; it shows a code
  that has to be approved through a unix socket in a `0700` directory. Nothing
  to phish or brute-force. Only approve codes you see on your own screen —
  `approve` prints the requesting browser's IP and user agent.
- **Only Claude can start a login.** Dynamic client registration rejects any
  `redirect_uri` other than Claude's callbacks (`BOX_MCP_REDIRECT_URIS`).
- **Tokens:** 1 h access tokens; refresh tokens rotate (60 s grace for
  concurrent refreshes) on a 90-day sliding window. Only SHA-256 hashes are
  stored, in `~/.local/state/box-mcp/state.json` (`0600`).
- **The real risk is prompt injection**, not the auth. A chat that reads email,
  Slack or web pages and also holds this tool can be talked into running
  commands. Keep the tool on "ask every time" and read what you approve.

## Configuration

Environment variables (set them with `systemctl --user edit box-mcp`):

| Variable | Default |
|---|---|
| `BOX_MCP_PORT` | `8808` |
| `BOX_MCP_PUBLIC_URL` | `https://` + this machine's Tailscale DNS name |
| `BOX_MCP_STATE_DIR` | `~/.local/state/box-mcp` |
| `BOX_MCP_REDIRECT_URIS` | Claude's two OAuth callbacks |
| `BOX_MCP_INSTRUCTIONS_FILE` | `~/.claude/CLAUDE.md` — appended to the tool description (see below) |
| `BOX_MCP_HOST_LABEL` | short hostname (shown in the `ssh … approve` hint) |

Lifetimes and limits are constants in [`src/config.ts`](src/config.ts).

## Development

Node ≥ 24 runs the TypeScript directly — no build step.

```sh
npm ci
npm test            # bash tool unit tests + a full OAuth/MCP flow against a real server process
npm run typecheck
```
