# devbox-dotfiles

Move your development to a remote server in one command. The remote box
becomes your daily driver: AI coding agents run there in isolation, keep
working after you close your laptop, and remain usable from your phone.

## What you get

- **One-command bootstrap** of a fresh Ubuntu VPS into a working dev box.
- **tmux + Claude Code wired for remote control** — detach and reattach
  from anywhere; sessions survive disconnects.
- **git + GitHub** ready for agents to pull and push unattended.
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

3. Sign in and set your git identity:

   ```sh
   claude            # sign in to Claude Code
   gh auth login     # GitHub auth — also wires up git push/pull
   ```

   ```ini
   # ~/.gitconfig.local
   [user]
       name  = Your Name
       email = you@example.com
   ```

Then `exec bash -l` to reload the shell, and you're set.

## Curious?

If you'd like to try this setup or see the full workflow in action — agents
running unattended on a remote box, picked back up from a laptop or a
phone — reach out at b.y.petryshyn@gmail.com and I'll happily walk you
through it.
