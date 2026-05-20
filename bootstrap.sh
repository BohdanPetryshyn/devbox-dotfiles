#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu VPS to match this machine's setup.
# Idempotent — safe to re-run.
#
# Usage on a fresh machine:
#   curl -fsSL https://raw.githubusercontent.com/BohdanPetryshyn/devbox-dotfiles/main/bootstrap.sh -o /tmp/bootstrap.sh
#   bash /tmp/bootstrap.sh
#
set -euo pipefail

DOTFILES_REPO="https://github.com/BohdanPetryshyn/devbox-dotfiles.git"
DOTFILES_DIR="$HOME/.dotfiles"
BACKUP_DIR="$HOME/.dotfiles-backup"

dot() { git --git-dir="$DOTFILES_DIR" --work-tree="$HOME" "$@"; }

### 1. Swap -------------------------------------------------------------------
# Many cloud images ship with no swap. Without it, memory pressure can trip
# direct-reclaim thrash instead of OOM-killing, leaving the box unresponsive.
SWAPFILE=/swapfile
SWAPSIZE_MB=4096

if ! swapon --show=NAME --noheadings | grep -qx "$SWAPFILE"; then
  if [ ! -e "$SWAPFILE" ]; then
    sudo fallocate -l "${SWAPSIZE_MB}M" "$SWAPFILE" \
      || sudo dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SWAPSIZE_MB" status=progress
    sudo chmod 600 "$SWAPFILE"
    sudo mkswap "$SWAPFILE"
  fi
  sudo swapon "$SWAPFILE"
fi

if ! grep -qE "^\s*${SWAPFILE}\s+" /etc/fstab; then
  echo "$SWAPFILE none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

### 2. apt prerequisites ------------------------------------------------------
sudo apt-get update
sudo apt-get install -y \
  build-essential curl git unzip \
  vim tmux mosh \
  unattended-upgrades

# mosh runs over UDP 60000-61000. Open the range if ufw is active.
if systemctl is-active --quiet ufw; then
  sudo ufw allow 60000:61000/udp >/dev/null
fi

# Enable automatic security updates. The package's default 50unattended-upgrades
# config installs from the -security pocket only, no auto-reboot — fine for a
# dev box. This file just turns the daily timers on.
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

### 3. Clone the dotfiles bare repo and check out into $HOME -----------------
if [ ! -d "$DOTFILES_DIR" ]; then
  git clone --bare "$DOTFILES_REPO" "$DOTFILES_DIR"
fi
dot config --local status.showUntrackedFiles no

# `git clone --bare` defaults to a mirror refspec — no `refs/remotes/origin/*`
# tracking refs, so `dot push`/`dot status -sb` need --set-upstream gymnastics.
# Switch to the normal refspec and wire `main` to track `origin/main`. All
# idempotent — safe to re-run.
dot config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
dot config branch.main.remote origin
dot config branch.main.merge refs/heads/main

# First checkout may collide with default skel files (.bashrc, .profile, ...).
# Back up conflicts, then retry. `|| true` keeps `set -e -o pipefail` from
# killing the script on the expected first-checkout failure.
if ! dot checkout 2>/dev/null; then
  mkdir -p "$BACKUP_DIR"
  { dot checkout 2>&1 || true; } | awk '/^\s+\./ {print $1}' | while read -r f; do
    [ -n "$f" ] && mv "$HOME/$f" "$BACKUP_DIR/$f"
  done
  dot checkout
fi

# On reruns, pull in changes pushed from other machines. --autostash tucks
# away any local working-tree edits so the rebase doesn't abort on them.
dot fetch origin
dot pull --rebase --autostash origin main

### 4. Homebrew (linuxbrew) ---------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"

### 5. brew packages ----------------------------------------------------------
# gcc is required by asdf-built tools; gh for GitHub auth/CLI; asdf for runtimes
brew install gcc asdf gh

### 6. asdf-managed runtimes --------------------------------------------------
asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git || true
asdf plugin add bun https://github.com/cometkim/asdf-bun.git || true
# Versions come from the checked-out ~/.tool-versions
asdf install
asdf reshim

### 7. Claude Code ------------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

### 8. ble.sh (fish-style autosuggestions + syntax highlighting in bash) -----
# .bashrc sources ~/.local/share/blesh/ble.sh; this just installs the files.
if [ ! -f "$HOME/.local/share/blesh/ble.sh" ]; then
  tmpdir=$(mktemp -d)
  git clone --recursive --depth 1 --shallow-submodules \
    https://github.com/akinomyoga/ble.sh.git "$tmpdir/ble.sh"
  make -C "$tmpdir/ble.sh" install PREFIX="$HOME/.local"
  rm -rf "$tmpdir"
fi

### 9. Tailscale -------------------------------------------------------------
# Mesh VPN so this box is reachable from my other devices (Mac, phone) over a
# stable 100.x.y.z IP — needed for e.g. WebRTC dev where a browser on the Mac
# must hit a server running here. The official installer sets up its own apt
# repo + systemd service. Joining the tailnet is a browser-auth step, deferred
# to the manual follow-ups below.
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

### 10. Manual follow-ups ----------------------------------------------------
cat <<'EOF'

bootstrap complete. Manual follow-ups:
  - gh auth login                       # GitHub auth; also rewrites .gitconfig
                                        # credential helper with this machine's
                                        # gh path (no-op on linuxbrew machines)
  - claude                              # sign in to Claude Code on first run
  - sudo tailscale up                   # browser-auth this box into the tailnet
  - copy ~/.ssh/ from a trusted backup  # not committed by design
  - if the VPS provider has a panel-level firewall (Contabo, Hetzner,
    AWS SG, etc.), also open UDP 60000-61000 there for mosh
  - Create ~/.gitconfig.local with your git identity:
      [user]
              name  = Your Name
              email = you@example.com
  - exec bash -l                        # reload shell so ble.sh + new PATH
                                        # take effect without reopening terminal
EOF
