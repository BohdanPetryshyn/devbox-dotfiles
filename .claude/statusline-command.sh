#!/bin/bash
# Claude Code statusLine command.
# All formatting/computation lives in statusline-command.py (pure stdlib
# Python — no jq dependency, since jq isn't installed on every machine).
# Bash just forwards stdin through to it.
exec python3 "$HOME/.claude/statusline-command.py"
