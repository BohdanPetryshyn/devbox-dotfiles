#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu VPS to match this machine's setup.
# Idempotent — safe to re-run.
#
# Usage on a fresh machine:
#   curl -fsSL https://raw.githubusercontent.com/BohdanPetryshyn/devbox-dotfiles/main/bootstrap.sh | bash
#
set -Eeuo pipefail   # -E: the ERR trap in main() also fires inside functions

DOTFILES_REPO="https://github.com/BohdanPetryshyn/devbox-dotfiles.git"
DOTFILES_DIR="$HOME/.dotfiles"
BACKUP_DIR="$HOME/.dotfiles-backup"

dot() { git --git-dir="$DOTFILES_DIR" --work-tree="$HOME" "$@"; }

# Everything below is the body of main(), called on the last line. bash must
# read a whole function before running any of it, which is what makes
# `curl … | bash` safe: piped in, bash reads the script from stdin as it goes,
# so a command that reads stdin too (brew's gcc install did) swallows the rest
# of the script and bootstrap stops there without an error. It also protects
# reruns from step 3 rewriting this very file while bash is still reading it.
# Not indented, to keep the diff and the heredocs simple.
main() {
# Three greppable markers tell whoever is driving — a person, or an agent
# following SETUP.md and polling the log — where things stand:
#   ==> ACTION NEEDED: …     waiting on a person; the link to open follows
#   ==> bootstrap FAILED …   stopped on an error
#   bootstrap complete       the closing message (step 14)
trap 'printf "\n==> bootstrap FAILED (line %s). Rerun the same command: it skips what is already done.\n" "$LINENO" >&2' ERR

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
# repo + systemd service. Joining the tailnet is a browser-auth step, done last
# (step 12) so everything unattended finishes first.
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

### 10. box-mcp (remote bash for Claude chat / Cowork) ------------------------
# ~/box-mcp is an MCP server exposing one `bash` tool to claude.ai, with its own
# OAuth server whose login is approved over SSH (see ~/box-mcp/README.md).
# This only installs it. Nothing runs and nothing is reachable until
# `box-mcp expose`, which the closing message (step 14) tells you to run.
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
# tailnet. Its Chrome is an ordinary one with the Claude in Chrome extension
# pre-installed, so Claude can drive the browser you are logged in to while you
# watch (see "Remote desktop & browser" in ~/.claude/CLAUDE.md) and websites
# see a normal browser. Three user units, checked out with the dotfiles:
#   desktop-x        Xvnc, the screen. VNC on a unix socket: no TCP, no password.
#   desktop-session  XFCE. Autostarts Chrome through ~/desktop/bin/chrome.
#   desktop-web      noVNC + websockify on 127.0.0.1:6080.
# This installs what they need and starts them. Nothing is reachable until
# `desktop-url` (step 12) adds the tailnet-only `tailscale serve`.
if [ "$(dpkg --print-architecture)" = amd64 ]; then
  # --no-install-recommends keeps XFCE lean (~200 MB RAM idle).
  sudo apt-get install -y --no-install-recommends \
    tigervnc-standalone-server websockify \
    xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings \
    xfce4-terminal xfce4-appfinder thunar exo-utils \
    dbus-x11 xdg-utils x11-xserver-utils xauth \
    adwaita-icon-theme librsvg2-common fonts-dejavu fonts-noto-color-emoji

  # Google Chrome rather than Chromium: the Claude extension comes from the
  # Chrome Web Store, and the .deb ships the AppArmor profile the sandbox needs
  # on Ubuntu. The .deb also registers Google's apt repo.
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

  # Pre-install the Claude in Chrome extension (how Claude drives that Chrome)
  # through Chrome's "external extensions" mechanism: on its next start Chrome
  # fetches it from the Web Store and opens its claude.ai sign-in tab. Not an
  # enterprise policy, which would label the browser "managed by your
  # organization". The file name is the extension's Web Store id.
  sudo install -d -m 755 /usr/share/google-chrome/extensions
  echo '{ "external_update_url": "https://clients2.google.com/service/update2/crx" }' \
    | sudo tee /usr/share/google-chrome/extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn.json >/dev/null

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

### 12. Join the tailnet ------------------------------------------------------
# Bootstrap is run by a person at a terminal, so do the one interactive step
# here: `tailscale up` prints a login URL and waits until it is approved in a
# browser — no second terminal, and it doesn't read stdin, so it works under
# `curl | bash`. Skipped once connected: a bare `tailscale up` on a configured
# node errors about unmentioned flags.
if ! tailscale status --json 2>/dev/null | grep -q '"BackendState": "Running"'; then
  printf '\n==> ACTION NEEDED: join your tailnet. Open the link below and approve this machine.\n\n'
  # Gives up after 15 minutes rather than waiting forever; a rerun gets a fresh link.
  sudo tailscale up --timeout=15m || true
fi

# Adds the tailnet-only `tailscale serve` for the remote desktop and prints its
# link. Tailscale's own output stays visible: on a tailnet without HTTPS enabled
# yet, it is one more link to approve. Absent where step 11 was skipped.
printf '\n==> Setting up the remote desktop link. If Tailscale prints a link below, open it:\n    it enables HTTPS for your tailnet (needed once).\n\n'
DESKTOP_URL=
if command -v desktop-url >/dev/null 2>&1; then
  DESKTOP_URL=$(desktop-url) || true
fi
DESKTOP_URL=${DESKTOP_URL:-"not ready. Run: sudo tailscale up && desktop-url"}

### 13. GitHub sign-in and git identity ---------------------------------------
# Same pattern as `tailscale up`: gh prints a one-time code and a link, then
# waits until the code is entered in a browser (any device). The code lasts 15
# minutes; if it lapses gh fails and a rerun gets a new one. GH_BROWSER=true
# stops gh trying to launch a browser on a headless box.
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  printf '\n==> ACTION NEEDED: sign in to GitHub. Open the link below and enter the one-time code.\n\n'
  GH_BROWSER=true gh auth login --hostname github.com --git-protocol https --web
fi
# git push/pull over https already use that login: the checked-out ~/.gitconfig
# sets gh as the credential helper for github.com.

# Commit identity, from the GitHub account. ~/.gitconfig includes this file;
# it stays untracked (per machine). Never overwritten — edit it to change.
# The no-reply address keeps a private email out of commits.
if [ ! -e "$HOME/.gitconfig.local" ]; then
  gh api user --jq '"[user]\n\tname = \(.name // .login)\n\temail = \(.email // "\(.id)+\(.login)@users.noreply.github.com")"' \
    > "$HOME/.gitconfig.local"
fi

### 14. What to do next -------------------------------------------------------
# Unquoted heredoc, for $DESKTOP_URL and the GitHub login: keep any other
# backticks and $ out of it.
cat <<EOF

================================================================================
  bootstrap complete
================================================================================

  Remote desktop:  $DESKTOP_URL

      Opens from any device on your tailnet. In its Chrome, sign in to
      claude.ai on the tab the Claude extension opened, then log in to the
      accounts you want Claude to use.

  GitHub:          signed in as $(gh api user --jq .login 2>/dev/null || echo "nobody yet: rerun bootstrap")

  Next, in order:

      1. exec bash -l       reload the shell: brew, asdf and claude on PATH
      2. box-mcp expose     connect Claude (chat and Cowork) to this computer;
                            it prints what to do next

  How to use this setup (tmux + Claude Code workflow, screenshots, ports):
      ~/README.md  ·  github.com/BohdanPetryshyn/devbox-dotfiles

EOF
}

# stdin from /dev/null: the same behaviour piped or run from a file, and
# nothing in there can sit waiting for input (sudo and `tailscale up` don't
# use stdin; apt/dpkg fall back to their defaults).
main "$@" </dev/null
