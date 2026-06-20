# devbox-dotfiles

Move your development to a remote server in one command. The remote box
becomes your daily driver: AI coding agents run there in isolation, keep
working after you close your laptop, and remain usable from your phone.

## What you get

- **One-command bootstrap** of a fresh Ubuntu VPS into a working dev box.
- **tmux + Claude Code wired for remote control** — detach and reattach
  from anywhere; sessions survive disconnects.
- **git + GitHub** ready for agents to pull and push unattended.
- **Reachable from anywhere** — a Tailscale mesh VPN puts the box and its
  dev servers a hop away from your laptop or phone.
- **A comfortable shell** — bash with
  [ble.sh](https://github.com/akinomyoga/ble.sh) autosuggestions, syntax
  highlighting, and prefix history search.
- **Security hardening out of the box** — key-only SSH, no root login,
  unattended security updates.

## Get started

1. **(Optional)** Some providers (AWS, GCP) give you a fresh box with a
   passwordless-sudo non-root user already set up. Others (Hetzner, Contabo,
   …) drop you straight into a root shell. In that case, run this first
   **as root** to create a `human` user, copy root's `authorized_keys` over,
   and harden SSH:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/BohdanPetryshyn/devbox-dotfiles/main/root.sh | bash
   ```

   Then log out and SSH back in as `human`.

2. As your normal user, run:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/BohdanPetryshyn/devbox-dotfiles/main/bootstrap.sh | bash
   ```

   Idempotent — rerun any time to pull in dotfile updates from this repo or
   from another machine you push from.

3. Reload the shell so the new tools land on `PATH`, then sign in:

   ```sh
   exec bash -l       # brew, asdf, claude on PATH; ble.sh active
   gh auth login      # GitHub auth — also wires up git push/pull
   claude             # sign in to Claude Code
   sudo tailscale up  # join your tailnet (browser auth)
   ```

   Set your git identity in `~/.gitconfig.local` (or just ask Claude to):

   ```ini
   [user]
       name  = Your Name
       email = you@example.com
   ```

That's it — see **Daily workflow** below for how to drive it.

## Daily workflow: tmux + Claude Code

tmux keeps your agents alive: start them on the box, detach, close your
laptop — they keep running. Reattach later from anywhere.

### tmux in 60 seconds

Every shortcut is the **prefix** `Ctrl-b`, released, then a key:

| Do this | How |
| --- | --- |
| New session named `work` | `tmux new -s work` |
| Detach (leave it running) | `Ctrl-b` then `d` |
| Reattach | `tmux a` or `tmux a -t work` |
| List sessions | `tmux ls`, or `Ctrl-b` then `s` |
| Kill a session | `tmux kill-session -t work` |
| New window | `Ctrl-b` then `c` |
| Next window | `Ctrl-b` then `n` |
| Rename window | `Ctrl-b` then `,` |
| List / pick windows | `Ctrl-b` then `w` |
| Kill window | `Ctrl-b` then `&` |

### Run an agent

The model: **one tmux session per agent.** Its first window runs the
agent; open more windows in the same session (`Ctrl-b` then `c`) for a
shell right beside it — run tests, `git`, tail logs — without
interrupting it. Detach and the agent keeps going.

```sh
tmux new -s cc-v1
claude --dangerously-skip-permissions --remote-control box-1-v1
```

Running several agents at once? Give each its own git worktree so they
never clobber each other's files — add `--worktree <task>` (from inside a
git repo):

```sh
claude --dangerously-skip-permissions --worktree v1 --remote-control box-1-v1
```

**Names** run in parallel across the two systems, both keyed to the task:

- **tmux session** → `cc-<task>` (e.g. `cc-v1`). The `cc-` prefix makes
  your agents stand out in `tmux ls`.
- **remote-control** → `box-1-<task>` (e.g. `box-1-v1`). The leading
  `box-1` is this box's hostname, so the Claude app tells you which
  machine a session is on once you run more than one box.

### Screenshots

Pasting an image into Claude Code doesn't work over SSH — your clipboard
lives on your Mac, not the box. `spaste` (in [`mac/`](mac/spaste.zsh))
bridges the gap: it ships your Mac clipboard image to the box and copies
the uploaded file's path back, ready to paste into Claude Code. Install
it on your Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/BohdanPetryshyn/devbox-dotfiles/main/mac/spaste.zsh \
  -o ~/.spaste.zsh
echo 'source ~/.spaste.zsh' >> ~/.zshrc && exec zsh
```

Then, with a screenshot on your clipboard (`Cmd+Ctrl+Shift+4`):

```sh
spaste box-1        # an SSH host from your ~/.ssh/config
```

and `Cmd+V` in Claude Code — it pastes the remote path.

### Reaching a server running on the box

When an agent starts a dev server (say on `:3000`), open it from your Mac
or phone two ways:

- **Tailscale** (always on): browse to `http://box-1:3000` — its tailnet
  name, or `100.x` IP — from any device on your tailnet, phone included.
- **VS Code port forwarding**: connected over Remote-SSH, the **Ports**
  panel auto-forwards the box's `localhost:3000` to your laptop's.

## Curious?

If you'd like to try this setup or see the full workflow in action — agents
running unattended on a remote box, picked back up from a laptop or a
phone — reach out at b.y.petryshyn@gmail.com and I'll happily walk you
through it.
