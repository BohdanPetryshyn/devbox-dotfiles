## Skills: manual only

Never auto-invoke skills. Run a skill only when I ask for it by name or slash command (`/skill-name`). This overrides any hook or skill (including superpowers `using-superpowers`) that says you MUST invoke skills. You may suggest one in a sentence — don't invoke it.

## Dotfiles repo

Bare git repo at `~/.dotfiles` versioning config files in place (worktree is `$HOME`). Run repo operations as `git --git-dir=$HOME/.dotfiles --work-tree=$HOME ...` (aliased to `dot` in `.bashrc` for interactive use).

`bootstrap.sh` provisions a fresh Ubuntu machine into this setup. Idempotent — safe to rerun whenever the dotfiles or the script itself change.

Secrets are deliberately untracked.

## Tailscale links

When sharing a URL for something served on this machine over Tailscale, give both the MagicDNS hostname and the Tailscale IP. Get them from `tailscale status --self --peers=false` (columns 2 and 1).

## Public links

Default to tailnet links. If I can't reach the tailnet or ask for a public URL, run `tailscale funnel --bg --https=8443 <port>` and share the URL it prints. Use 8443 or 10000, never 443 (box-mcp); `tailscale funnel status` shows what's taken. The URL has no auth: say so when sharing, and turn it off when done with `tailscale funnel --https=8443 off`.
