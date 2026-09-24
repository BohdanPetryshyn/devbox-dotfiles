# Setting up a box with Claude's help

A runbook for a Claude Code session on someone's **own computer** (the desktop
app's Code tab or the CLI — it needs a local shell) that sets up their new
server over SSH. It is written for the agent, and plainly enough for the person
to read along.

**To the agent.** The person asked you to follow this file. The scripts do the
installing — your job is to guide the person, start the scripts, watch, and
pass links on. Do not re-implement or "improve" the scripts step by step: if
one fails, rerun it (both are idempotent) and show the person the log if it
fails twice. Never create accounts for them, and never ask for or enter their
passwords or tokens: every sign-in below (Tailscale, GitHub, Claude) is done by
the person in their own browser. The one code you do handle is box-mcp's in
step 6, which is approved over SSH by design.

**How to guide them.** Assume they are not technical. Open with the roadmap
below in a few lines and get a yes. Then, at each step, say in one or two
sentences what is happening now and what — if anything — they need to do, using
the *Say* line as a guide. One ask at a time. Explain the *what*, not the
*how*: no walls of text, no command output unless something fails, no
explaining what SSH or a tailnet is unless they ask.

> **Roadmap:** 1) make a key for your server · 2) you rent the server (~5 min,
> the only paid part) · 3) I prepare it · 4) I install everything (~15 min;
> you approve two sign-ins when I hand you the links) · 5) I make it easy to
> reach · 6) you connect your Claude apps to it.

They will need, along the way: a **Tailscale** account with the Tailscale app
installed and signed in on this computer, a **GitHub** account, and a paid
**Claude** plan. Mention these up front so they can sort them out while the
install runs; don't stop to check each one.

## 1. A key for the server

*Say:* "First I'll make the key your server will recognise this computer by."

Check for `~/.ssh/id_ed25519.pub`. If there is none, create one with
`ssh-keygen -t ed25519` (ask whether they want a passphrase; without one the
key is only as safe as this computer).

## 2. They rent the server

*Say:* "Now rent the server — this is the one part only you can do. Here is
what to pick, and your key to paste in." Then give them exactly this, and the
**public** key:

- Where: Hetzner Cloud, <https://console.hetzner.com/> → a project → *Add
  Server* (any provider with plain Ubuntu servers works the same way).
- **Image:** Ubuntu 26.04. **Type:** shared vCPU, **x86** (Intel/AMD) — *not*
  Arm/Ampere ("CAX"): the remote desktop needs x86. **8 GB RAM recommended.**
  If a type is sold out, try another location.
- **Networking:** keep the public IPv4 on. **SSH key:** paste the key.
- Create it, then tell me the server's **IP address**.

Call that address `IP` below.

## 3. A normal user, and key-only login

*Say:* "Got it. I'm creating a regular user on the server and switching off
password logins, so only your key can get in. OK to go ahead?" — wait for a yes.

```sh
ssh -o StrictHostKeyChecking=accept-new root@IP 'curl -fsSL https://raw.githubusercontent.com/BohdanPetryshyn/devbox-dotfiles/main/root.sh | bash'
```

[`root.sh`](root.sh) creates the user `agent` with passwordless sudo, copies
root's authorized key to it, and turns off root and password logins. Confirm
the new login works before going on: `ssh agent@IP 'sudo -n true && echo ok'`.
(If the provider already gave them a sudo user instead of root, skip this step
and use that user in place of `agent`.)

## 4. Install everything

*Say:* "Now the main install: developer tools, a remote desktop with Chrome,
and the pieces that connect Claude. About 15 minutes. Twice I'll hand you a
link to approve — Tailscale, then GitHub. Nothing else needed from you."

It has to outlive dropped connections, so start it in the background on the
box with its output going straight to a log file. Replace `Area/City` with this
computer's time zone, so the box's Chrome reports the person's own: on macOS
and Linux it is the end of `readlink /etc/localtime`, after `zoneinfo/`.

```sh
ssh agent@IP 'sudo loginctl enable-linger "$USER"; nohup bash -c "curl -fsSL https://raw.githubusercontent.com/BohdanPetryshyn/devbox-dotfiles/main/bootstrap.sh | BOX_TIMEZONE=Area/City bash" > ~/bootstrap.log 2>&1 < /dev/null &'
```

Then poll about once a minute, and read the end of the log:

```sh
ssh agent@IP 'tail -n 25 ~/bootstrap.log'
```

| The log shows | Meaning | What you do |
| --- | --- | --- |
| ordinary install output | working (Homebrew alone can be quiet for minutes) | keep polling; a one-line progress note every few minutes is plenty |
| `==> ACTION NEEDED: …` | waiting on the person; the link follows in the log | give them the link (and the code, for GitHub) with one sentence on what it is for, then keep polling — the script continues by itself once they approve |
| `bootstrap complete` | done | go to step 5 |
| `==> bootstrap FAILED (line N)` | stopped on an error | rerun the command above once; if it fails again, show them the log tail |

Expect these approvals, in order:

1. **Tailscale** — a `login.tailscale.com` link. *Say:* "This adds the server
   to your private network. Approve it with the same Tailscale account you use
   on this computer." (`ssh agent@IP 'tailscale status --json' | grep -E
   '"(BackendState|AuthURL)"'` shows the same state without reading the log.)
2. **Tailscale HTTPS** — only on a tailnet that never enabled it: a second
   Tailscale link, printed after "Setting up the remote desktop link". *Say:*
   "One more Tailscale approval — it turns on secure links inside your network."
3. **GitHub** — a one-time code and `https://github.com/login/device`. *Say:*
   "This lets the server push and pull your code. Open the link and type this
   code." The code lasts 15 minutes; a lapsed one ends in `FAILED`, and a rerun
   gets a new one.

## 5. Make the box easy to reach

*Say:* "Installed. I'm adding a shortcut so this computer knows the server by
a short name." Ask what to call it (`box` here).

From the closing message in the log, note the **Remote desktop** link. Add to
`~/.ssh/config` on this computer:

```
Host box
    HostName IP
    User agent
```

## 6. Hand over to the person

*Say:* "The server is ready. Three things left, all yours — I'll take them one
at a time." Give one, wait until it is done, then the next.

1. **Remote desktop**: open the link from step 5. In its Chrome, sign in to
   claude.ai on the tab the Claude extension opened, then log in to the
   accounts they want Claude to use there.
2. **Claude desktop app**: add an SSH environment with host `box`. New Code
   sessions can then run on the box.
3. **Claude chat and Cowork**: run `box-mcp expose` on the box the way you ran
   bootstrap — detached, with a log you poll — because on a tailnet that never
   enabled Funnel it prints a Tailscale link and *waits* for the approval; run
   in the foreground, you would not see that link until it gave up:

   ```sh
   ssh box 'nohup box-mcp expose > ~/box-mcp-expose.log 2>&1 < /dev/null &'
   ssh box 'tail -n 25 ~/box-mcp-expose.log'
   ```

   A `login.tailscale.com` link in the log: pass it on (*Say:* "One more
   Tailscale approval — it lets Claude's servers reach this one service on your
   box."). `✔ box-mcp is live.`: give them the connector **name** and **URL**
   it printed, to add under Claude → Settings → Connectors. The page that
   opens shows a one-time code: they read it to you, and you run
   `ssh box box-mcp approve <CODE>`.

Close with two lines: what they now have, and that the
[README](README.md) shows how to use it day to day.
