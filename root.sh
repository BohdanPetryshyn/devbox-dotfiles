#!/usr/bin/env bash
# Bootstrap a sudo user on a fresh Ubuntu box. Run as root.
#   curl -fsSL https://.../root.sh | bash
#   or: bash root.sh [username]
#
# - Creates user (default: human), passwordless sudo
# - Copies root's authorized_keys to the new user
# - Drops SSH hardening into /etc/ssh/sshd_config.d/99-hardening.conf
# - Reloads sshd
#
# After running, log in as the new user and handle the rest
# (unattended-upgrades, ufw, fail2ban, etc.) yourself.

set -euo pipefail

USERNAME="${1:-human}"

if [[ $EUID -ne 0 ]]; then
  echo "must run as root" >&2
  exit 1
fi

if [[ ! -s /root/.ssh/authorized_keys ]]; then
  echo "/root/.ssh/authorized_keys is missing or empty — refusing to lock you out" >&2
  exit 1
fi

# 1. User + passwordless sudo
if id "$USERNAME" &>/dev/null; then
  echo "user $USERNAME already exists, skipping creation"
else
  adduser --disabled-password --gecos "" "$USERNAME"
fi
usermod -aG sudo "$USERNAME"

install -m 0440 /dev/stdin "/etc/sudoers.d/$USERNAME" <<EOF
$USERNAME ALL=(ALL) NOPASSWD:ALL
EOF
visudo -cf "/etc/sudoers.d/$USERNAME" >/dev/null

# 2. SSH keys from root
HOME_DIR="$(getent passwd "$USERNAME" | cut -d: -f6)"
install -d -m 0700 -o "$USERNAME" -g "$USERNAME" "$HOME_DIR/.ssh"
install -m 0600 -o "$USERNAME" -g "$USERNAME" \
  /root/.ssh/authorized_keys "$HOME_DIR/.ssh/authorized_keys"

# 3. SSH hardening drop-in
install -m 0644 /dev/stdin /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
# Managed by devbox/root.sh — key-only login, no root SSH.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
EOF

sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo
echo "done. test in a NEW terminal before closing this session:"
echo "  ssh $USERNAME@<host>"
echo "  sudo -n true   # should succeed silently"
