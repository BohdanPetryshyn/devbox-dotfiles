#!/usr/bin/env python3
r"""Claude Code statusLine.

Left: current working directory (with $HOME abbreviated to ~), in muted
gray to match Claude Code's own dimmed footer styling.
Right: model name with effort level ("Fable 5 · xhigh"), context-window
usage ("ctx NN% (Xk/Yk)") and account rate-limit usage ("5h 32% · wk 61%",
the same data as /usage), right-aligned to the terminal width. Gray
throughout, except percentages which are colored by how close they are
to their limit.

Reads the statusLine JSON from stdin and does all parsing/formatting here
in a single python3 process (stdlib only, no jq/pip dependency).
"""
import json
import os
import re
import sys

GRAY = "\033[90m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[00m"

ANSI_RE = re.compile(r"\033\[[0-9;]*m")


def read_input():
    try:
        raw = sys.stdin.read()
    except Exception:
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def visible_len(s):
    return len(ANSI_RE.sub("", s))


def term_width():
    # Claude Code (v2.1.153+) passes the available width via COLUMNS —
    # prefer it over the raw tty size, which can be wider than the
    # space the status line actually gets.
    try:
        width = int(os.environ.get("COLUMNS", "") or 0) or None
    except ValueError:
        width = None

    if not width:
        try:
            import fcntl
            import struct
            import termios

            with open("/dev/tty", "rb") as tty:
                packed = fcntl.ioctl(
                    tty, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0)
                )
                _rows, cols, _xpix, _ypix = struct.unpack("HHHH", packed)
                if cols:
                    width = cols
        except Exception:
            width = None

    if not width:
        width = 80

    # The TUI reserves ~2 columns each side of the status line row on top
    # of the terminal width it reports, and truncates overflow with "…".
    return max(width - 5, 0)


def abbreviate_path(path):
    home = os.path.expanduser("~")
    if home and home != "/" and (path == home or path.startswith(home + "/")):
        return "~" + path[len(home):]
    return path


def fmt_tokens(n):
    n = int(n)
    if n >= 1000:
        return f"{n / 1000:.0f}k"
    return str(n)


def last_assistant_usage(transcript_path, tail_bytes=200_000):
    """Sum input/cache/output tokens from the last assistant message's
    usage in the transcript (JSONL, one JSON object per line). Only reads
    a bounded tail of the file so this stays fast on long sessions."""
    if not transcript_path:
        return None
    try:
        with open(transcript_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - tail_bytes))
            chunk = f.read()
    except OSError:
        return None

    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") != "assistant":
            continue
        usage = (entry.get("message") or {}).get("usage")
        if not usage:
            continue
        return (
            (usage.get("input_tokens") or 0)
            + (usage.get("cache_read_input_tokens") or 0)
            + (usage.get("cache_creation_input_tokens") or 0)
            + (usage.get("output_tokens") or 0)
        )
    return None


def pct_color(pct):
    if pct < 60:
        return GRAY
    if pct < 85:
        return YELLOW
    return RED


def ctx_text(data):
    """Return 'ctx NN% (Xk/Yk)' with the percentage colored, or None if
    context info is unavailable."""
    cw = data.get("context_window")
    if not isinstance(cw, dict):
        return None  # context info entirely absent from the input

    window_size = cw.get("context_window_size")
    if not window_size:
        return None  # can't compute anything meaningful without a window size

    used_pct = cw.get("used_percentage")
    tokens_used = (cw.get("total_input_tokens") or 0) + (cw.get("total_output_tokens") or 0)

    if used_pct is None:
        # No API response yet this session (used_percentage is null until
        # then) — derive usage from the transcript instead.
        derived = last_assistant_usage(data.get("transcript_path"))
        if derived is not None:
            tokens_used = derived
        used_pct = (tokens_used / window_size) * 100

    pct = round(used_pct)
    return f"ctx {pct_color(pct)}{pct}%{GRAY} ({fmt_tokens(tokens_used)}/{fmt_tokens(window_size)})"


def rate_limits_text(data):
    """Return '5h 32% · wk 61%' with percentages colored, or None.
    rate_limits only appears for subscription accounts after the first
    API response of the session, and each window may be independently
    absent — show whatever is there."""
    rl = data.get("rate_limits")
    if not isinstance(rl, dict):
        return None
    parts = []
    for key, label in (("five_hour", "5h"), ("seven_day", "wk")):
        window = rl.get(key)
        if not isinstance(window, dict):
            continue
        used_pct = window.get("used_percentage")
        if used_pct is None:
            continue
        pct = round(used_pct)
        parts.append(f"{label} {pct_color(pct)}{pct}%{GRAY}")
    if not parts:
        return None
    return " · ".join(parts)


def right_side(data):
    parts = []
    model_name = (data.get("model") or {}).get("display_name")
    if model_name:
        # Absent when the model doesn't support the effort parameter.
        effort = (data.get("effort") or {}).get("level")
        parts.append(f"{model_name} · {effort}" if effort else model_name)
    ctx = ctx_text(data)
    if ctx:
        parts.append(ctx)
    limits = rate_limits_text(data)
    if limits:
        parts.append(limits)
    if not parts:
        return ""
    return f"{GRAY}{' | '.join(parts)}{RESET}"


def main():
    data = read_input()

    cwd = data.get("cwd") or os.getcwd()
    left = f"{GRAY}{abbreviate_path(cwd)}{RESET}"
    right = right_side(data)

    if right:
        gap = term_width() - visible_len(left) - visible_len(right)
        sep = " " * gap if gap >= 1 else " "
        sys.stdout.write(left + sep + right)
    else:
        sys.stdout.write(left)


if __name__ == "__main__":
    main()
