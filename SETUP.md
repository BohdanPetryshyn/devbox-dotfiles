# Setting up a box with Claude's help

A runbook for a Claude Code session on someone's **own computer** (the desktop
app's Code tab or the CLI — it needs a local shell) that sets up their new
server over SSH. It is written for the agent, and plainly enough for the person
to read along.

**To the agent.** The person asked you to follow this file. Before you start,
tell them in a few lines what is about to happen and get a yes; ask again
before step 2, which changes how their server accepts logins. The scripts do
the installing — your job is to start them, watch, and pass links to the
person. Do not re-implement or "improve" the scripts step by step: if one
fails, rerun it (both are idempotent) and show the person the log if it fails
twice. Never create accounts for them, and never ask for or enter their
passwords or tokens: every sign-in below (Tailscale, GitHub, Claude) is done by
the person in their own browser. The one code you do handle is box-mcp's in
step 5, which is approved over SSH by design.

## What the person needs

- A fresh **Ubuntu** server with a public IP, **x86-64** (on Hetzner: not the
  Arm "CAX" types — the remote desktop is skipped there). Step 1 comes first.
- A **Tailscale** account, with the Tailscale app installed and signed in on
  this computer.
- A **GitHub** account.
- A paid **Claude** plan (for the Claude in Chrome extension on the box).

## 1. An SSH key for the server

Check for `~/.ssh/id_ed25519.pub`. If there is none, create one with
`ssh-keygen -t ed25519` (ask whether they want a passphrase; without one the
key is only as safe as this computer). Show the **public** key and ask them to
paste it into the "SSH key" field while creating the server, then to give you
the server's IP address. Call it `IP` below.

## 2. A normal user, and key-only SSH

```sh
ssh -o StrictHostKeyChecking=accept-new root@IP 'curl -fsSL https://raw.githubusercontent.com/BohdanPetryshyn/devbox-dotfiles/main/root.sh | bash'
```

[`root.sh`](root.sh) creates the user `agent` with passwordless sudo, copies
root's authorized key to it, and turns off root and password logins. Confirm
the new login works before going on: `ssh agent@IP 'sudo -n true && echo ok'`.
(If the provider already gave them a sudo user instead of root, skip this step
and use that user in place of `agent`.)

## 3. Run bootstrap, detached

It takes 10–15 minutes and has to outlive dropped connections, so start it in
the background on the box with its output going straight to a log file:

```sh
ssh agent@IP 'sudo loginctl enable-linger "$USER"; nohup bash -c "curl -fsSL https://raw.githubusercontent.com/BohdanPetryshyn/devbox-dotfiles/main/bootstrap.sh | bash" > ~/bootstrap.log 2>&1 < /dev/null &'
```

Then poll about once a minute, and read the end of the log:

```sh
ssh agent@IP 'tail -n 25 ~/bootstrap.log'
```

| The log shows | Meaning | What you do |
| --- | --- | --- |
| ordinary install output | working (Homebrew alone can be quiet for minutes) | keep polling |
| `==> ACTION NEEDED: …` | waiting on the person; the link follows in the log | give them the link (and the code, for GitHub), then keep polling — the script continues by itself once they approve |
| `bootstrap complete` | done | go to step 4 |
| `==> bootstrap FAILED (line N)` | stopped on an error | rerun the step-3 command once; if it fails again, show them the log tail |

Expect these approvals, in order:

1. **Tailscale** — a `login.tailscale.com` link. They must approve with the
   *same* Tailscale account this computer uses. `ssh agent@IP 'tailscale status
   --json' | grep -E '"(BackendState|AuthURL)"'` shows the same state without
   reading the log.
2. **Tailscale HTTPS** — only on a tailnet that never enabled it: a second
   Tailscale link, printed after "Setting up the remote desktop link".
3. **GitHub** — a one-time code and `https://github.com/login/device`. The
   code lasts 15 minutes; a lapsed one ends in `FAILED`, and a rerun gets a
   new one.

## 4. Make the box easy to reach

From the closing message in the log, note the **Remote desktop** link. Add an
entry to `~/.ssh/config` on this computer (ask for a short name; `box` here):

```
Host box
    HostName IP
    User agent
```

## 5. Hand over to the person

These are theirs to do; give them as a short checklist.

1. **Remote desktop**: open the link from step 4. In its Chrome, sign in to
   claude.ai on the tab the Claude extension opened, then log in to the
   accounts they want Claude to use there.
2. **Claude desktop app**: add an SSH environment with host `box`. New Code
   sessions can then run on the box.
3. **Claude chat and Cowork**: run `ssh box box-mcp expose` and pass on what it
   prints — possibly one more Tailscale link (to enable Funnel), then a
   connector name and URL to add under Claude → Settings → Connectors. The
   page that opens shows a one-time code: they read it to you, and you run
   `ssh box box-mcp approve <CODE>`.

How the box is meant to be used from here: the [README](README.md).
