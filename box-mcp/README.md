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

`bootstrap.sh` installs dependencies, links the CLI and starts the service. It
listens on localhost only, so nothing is exposed until you open Funnel:

```sh
sudo tailscale set --operator=$USER
tailscale funnel --bg 8808    # first run prints a link to enable Funnel + HTTPS on the tailnet
box-mcp url                   # → https://<machine>.<tailnet>.ts.net/mcp
```

Then in Claude: **Settings → Connectors → Add custom connector**, paste the URL,
and click **Connect**. A page shows a one-time code:

```sh
ssh <box> box-mcp approve K7Q2-MXPD
```

The page notices the approval and returns to Claude. That one login covers
every device on the Claude account (web, desktop, mobile, Cowork) and lasts as
long as the connector is used at least once every 90 days.

Set the `bash` tool to **ask every time** in the connector's tool permissions.

## CLI

```
box-mcp approve <CODE>     approve the login showing CODE in your browser
box-mcp deny <CODE>        reject it
box-mcp pending            logins waiting for approval
box-mcp grants             active logins
box-mcp revoke <id|--all>  log a connector out
box-mcp url                connector URL
```

Kill switch: `systemctl --user stop box-mcp`, or `tailscale funnel reset` to
take it off the internet while leaving it running.

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
| `BOX_MCP_HOST_LABEL` | short hostname (shown in the `ssh … approve` hint) |

Lifetimes and limits are constants in [`src/config.ts`](src/config.ts).

## Development

Node ≥ 24 runs the TypeScript directly — no build step.

```sh
npm ci
npm test            # bash tool unit tests + a full OAuth/MCP flow against a real server process
npm run typecheck
```
