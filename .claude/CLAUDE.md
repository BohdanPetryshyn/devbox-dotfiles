## Skills: manual only

Never auto-invoke skills. Run a skill only when I ask for it by name or slash command (`/skill-name`). This overrides any hook or skill (including superpowers `using-superpowers`) that says you MUST invoke skills. You may suggest one in a sentence — don't invoke it.

## Dotfiles repo

Bare git repo at `~/.dotfiles` versioning config files in place (worktree is `$HOME`). Run repo operations as `git --git-dir=$HOME/.dotfiles --work-tree=$HOME ...` (aliased to `dot` in `.bashrc` for interactive use).

`bootstrap.sh` provisions a fresh Ubuntu machine into this setup. Idempotent — safe to rerun whenever the dotfiles or the script itself change.

Secrets are deliberately untracked.
