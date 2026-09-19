# Environment for everything box-mcp runs: the server, the CLI, and every
# command executed by the `bash` tool (via BASH_ENV).
#
# ~/.bashrc bails out early for non-interactive shells, so none of its PATH
# setup applies here. This mirrors the tail of ~/.bashrc so remote commands see
# the same tools (brew, asdf runtimes, ~/.local/bin) and per-machine secrets as
# an SSH session. Keep it quiet: anything printed here pollutes tool output.

if [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"
fi
export PATH="$HOME/.asdf/shims:$PATH"
export PATH="$HOME/.local/bin:$PATH"

# Per-machine secrets & env (API tokens, etc.) — untracked.
[ -f "$HOME/.bashrc.local" ] && . "$HOME/.bashrc.local"

# No pagers or interactive prompts: there is no TTY on the other end.
export PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER= GIT_TERMINAL_PROMPT=0 DEBIAN_FRONTEND=noninteractive
