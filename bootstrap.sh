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
  vim tmux \
  unattended-upgrades

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

# asdf installs runtimes as shims under ~/.asdf/shims; .bashrc adds that to PATH
# for interactive shells, but this non-interactive script needs it too so the
# `npm`/`node` shims below resolve.
export PATH="$HOME/.asdf/shims:$PATH"

# Global Node CLIs. wrangler = Cloudflare Workers/Pages CLI; reads creds from
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in ~/.bashrc.local (see follow-ups).
# reshim so asdf exposes the freshly installed bin.
if ! command -v wrangler >/dev/null 2>&1; then
  npm install -g wrangler
  asdf reshim nodejs
fi

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

### 10. box-mcp (remote bash for Claude chat / Cowork) ------------------------
# ~/box-mcp is an MCP server exposing one `bash` tool to claude.ai, with its own
# OAuth server whose login is approved over SSH (see ~/box-mcp/README.md).
# This only installs it. Nothing runs and nothing is reachable until you opt in
# with `box-mcp expose` (manual follow-ups below).
npm ci --prefix "$HOME/box-mcp" --omit=dev --no-audit --no-fund

# /usr/local/bin is on the PATH of a bare `ssh box box-mcp approve <CODE>`;
# ~/.local/bin is not (non-interactive, non-login shell).
sudo ln -sf "$HOME/box-mcp/bin/box-mcp" /usr/local/bin/box-mcp

# Already opted in on this machine? Then pick up the code pulled in step 3.
if systemctl --user is-enabled --quiet box-mcp 2>/dev/null; then
  systemctl --user daemon-reload
  systemctl --user restart box-mcp
fi

### 11. Remote desktop (a desktop in a browser tab + a Chrome Claude can drive)
# A persistent XFCE desktop on display :1, viewable from any device on the
# tailnet. Its Chrome exposes CDP on localhost, so Claude can drive the browser
# you are logged in to while you watch (see "Remote desktop & browser" in
# ~/.claude/CLAUDE.md). Three user units, checked out with the dotfiles:
#   desktop-x        Xvnc, the screen. VNC on a unix socket: no TCP, no password.
#   desktop-session  XFCE. Autostarts Chrome through ~/desktop/bin/chrome.
#   desktop-web      noVNC + websockify on 127.0.0.1:6080.
# This installs what they need and starts them. Nothing is reachable until
# `desktop-url` (manual follow-ups) adds the tailnet-only `tailscale serve`.
if [ "$(dpkg --print-architecture)" = amd64 ]; then
  # --no-install-recommends keeps XFCE lean (~200 MB RAM idle).
  sudo apt-get install -y --no-install-recommends \
    tigervnc-standalone-server websockify \
    xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings \
    xfce4-terminal xfce4-appfinder thunar exo-utils \
    dbus-x11 xdg-utils x11-xserver-utils xauth \
    adwaita-icon-theme librsvg2-common fonts-dejavu fonts-noto-color-emoji

  # Google Chrome, not a Playwright-bundled Chromium: sites accept logins in
  # it, and its .deb ships the AppArmor profile the sandbox needs on Ubuntu.
  # The .deb also registers Google's apt repo.
  if ! command -v google-chrome-stable >/dev/null 2>&1; then
    tmpdir=$(mktemp -d)
    chmod 755 "$tmpdir"   # apt reads the .deb as its sandbox user
    curl -fsSL -o "$tmpdir/chrome.deb" \
      https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    sudo apt-get install -y --no-install-recommends "$tmpdir/chrome.deb"
    rm -rf "$tmpdir"
  fi

  # Step 2 only auto-installs Ubuntu security updates. A browser holding
  # logged-in sessions has to stay current too, so add Google's repo.
  sudo tee /etc/apt/apt.conf.d/51unattended-upgrades-chrome >/dev/null <<'EOF'
Unattended-Upgrade::Origins-Pattern {
	"origin=Google LLC,codename=stable";
};
EOF

  # noVNC, the in-browser VNC client: static files from the upstream release,
  # pinned by checksum. Not apt's `novnc`, which drags in a system nodejs that
  # would shadow the asdf one for non-interactive shells.
  NOVNC_VERSION=1.6.0
  NOVNC_SHA256=5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa
  NOVNC_DIR="$HOME/desktop/web/novnc"
  if ! grep -qs "\"version\": \"$NOVNC_VERSION\"" "$NOVNC_DIR/package.json"; then
    tmpdir=$(mktemp -d)
    curl -fsSL -o "$tmpdir/novnc.tar.gz" \
      "https://github.com/novnc/noVNC/archive/refs/tags/v$NOVNC_VERSION.tar.gz"
    echo "$NOVNC_SHA256  $tmpdir/novnc.tar.gz" | sha256sum -c -
    rm -rf "$NOVNC_DIR"
    mkdir -p "$NOVNC_DIR"
    # Only what the client needs — no tests, docs or utils.
    tar xzf "$tmpdir/novnc.tar.gz" -C "$NOVNC_DIR" --strip-components=1 \
      "noVNC-$NOVNC_VERSION"/{app,core,vendor,vnc.html,package.json,defaults.json,mandatory.json,LICENSE.txt}
    rm -rf "$tmpdir"
  fi

  # playwright-cli: how Claude drives that Chrome (attaches over CDP, so it
  # needs no browser download of its own).
  if ! command -v playwright-cli >/dev/null 2>&1; then
    npm install -g @playwright/cli
    asdf reshim nodejs
  fi

  # On PATH for Claude and for a bare `ssh box desktop-url` (see box-mcp above).
  sudo ln -sf "$HOME/desktop/bin/desktop-url" /usr/local/bin/desktop-url

  # User units only run at boot / without a login session if lingering is on.
  sudo loginctl enable-linger "$USER"
  systemctl --user daemon-reload
  # Deliberately not restarted on reruns: restarting desktop-x closes everything
  # open on the desktop. After editing a unit: systemctl --user restart desktop-x
  systemctl --user enable --now desktop-x desktop-session desktop-web
else
  echo "Skipping the remote desktop: it installs Google Chrome's amd64 .deb." >&2
fi

### 12. Manual follow-ups ----------------------------------------------------
cat <<'EOF'

bootstrap complete. Manual follow-ups, in order:

  1. exec bash -l                      # reload: brew/asdf/claude on PATH, ble.sh
  2. gh auth login
  3. claude                            # sign in
  4. ask claude to add ~/.gitconfig.local with your git identity
  5. sudo tailscale up                 # browser-auth into the tailnet
  6. desktop-url                       # prints the remote desktop's link (tailnet only).
                                       # Open it, log in to your accounts in its Chrome,
                                       # then ask Claude to "use my browser".
  7. (optional) give Claude chat/Cowork a shell on this box:
       box-mcp expose                  # starts it, opens Tailscale Funnel, prints what to do next

Using this setup (tmux + Claude Code workflow, screenshots, ports):
  ~/README.md  ·  github.com/BohdanPetryshyn/devbox-dotfiles
EOF
