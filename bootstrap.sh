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

### 1. apt prerequisites ------------------------------------------------------
sudo apt-get update
sudo apt-get install -y build-essential curl git vim tmux

### 2. Clone the dotfiles bare repo and check out into $HOME -----------------
if [ ! -d "$DOTFILES_DIR" ]; then
  git clone --bare "$DOTFILES_REPO" "$DOTFILES_DIR"
fi
dot config --local status.showUntrackedFiles no

# First checkout may collide with default skel files (.bashrc, .profile, ...).
# Back up conflicts, then retry.
if ! dot checkout 2>/dev/null; then
  mkdir -p "$BACKUP_DIR"
  dot checkout 2>&1 | grep -E "^\s+\." | awk '{print $1}' | while read -r f; do
    mv "$HOME/$f" "$BACKUP_DIR/$f"
  done
  dot checkout
fi

### 3. Homebrew (linuxbrew) ---------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"

### 4. brew packages ----------------------------------------------------------
# gcc is required by asdf-built tools; gh for GitHub auth/CLI; asdf for runtimes
brew install gcc asdf gh

### 5. asdf-managed runtimes --------------------------------------------------
asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git || true
# Versions come from the checked-out ~/.tool-versions
asdf install
asdf reshim

### 6. Claude Code ------------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

### 7. Manual follow-ups -----------------------------------------------------
cat <<'EOF'

bootstrap complete. Manual follow-ups:
  - gh auth login                       # GitHub auth; also rewrites .gitconfig
                                        # credential helper with this machine's
                                        # gh path (no-op on linuxbrew machines)
  - claude                              # sign in to Claude Code on first run
  - copy ~/.ssh/ from a trusted backup  # not committed by design
  - Create ~/.gitconfig.local with your git identity:
      [user]
              name  = Your Name
              email = you@example.com
EOF
