## Dotfiles repo

Bare git repo at `~/.dotfiles` versioning config files in place (worktree is `$HOME`). Run repo operations as `git --git-dir=$HOME/.dotfiles --work-tree=$HOME ...` (aliased to `dot` in `.bashrc` for interactive use).

`bootstrap.sh` provisions a fresh Ubuntu machine into this setup. Idempotent — safe to rerun whenever the dotfiles or the script itself change.

Secrets are deliberately untracked.
