import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { HOST_LABEL } from './config.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

type PageData = { rid: string; userCode: string; clientName?: string; ttl: number };

/** The page Claude's OAuth popup lands on: shows the one-time code and waits for SSH approval. */
export function renderAuthorizePage(res: Response, { rid, userCode, clientName, ttl }: PageData) {
  const nonce = randomBytes(16).toString('base64');
  const command = `ssh ${HOST_LABEL} box-mcp approve ${userCode}`;

  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200).type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Approve access · ${esc(HOST_LABEL)}</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg:#f6f5f2; --fg:#1d1c1a; --muted:#6b6862; --card:#fff; --line:#dedbd4; --accent:#c2410c; --ok:#15803d; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#ecebe7; --muted:#9a968d; --card:#201f1c; --line:#35332e; --accent:#fb923c; --ok:#4ade80; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--fg);
         font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { width:100%; max-width:30rem; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; }
  h1 { font-size:1.15rem; margin:0 0 4px; }
  p { margin:0 0 16px; color:var(--muted); }
  .code { font:600 2.4rem/1.1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.08em; text-align:center; margin:20px 0; }
  .cmd { display:flex; gap:8px; align-items:stretch; }
  pre { flex:1; margin:0; padding:12px; overflow-x:auto; background:var(--bg); border:1px solid var(--line); border-radius:8px;
        font:.85rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
  button { border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); padding:0 14px; font:inherit; cursor:pointer; }
  button:hover { border-color:var(--accent); }
  #status { margin:20px 0 0; font-size:.9rem; }
  #status.ok { color:var(--ok); } #status.bad { color:var(--accent); }
  .dot { display:inline-block; width:.55em; height:.55em; border-radius:50%; background:var(--accent); margin-right:.5em; animation:pulse 1.2s infinite; }
  @keyframes pulse { 50% { opacity:.25; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation:none; } }
</style>
</head>
<body>
<main>
  <h1>Approve shell access to ${esc(HOST_LABEL)}</h1>
  <p>${esc(clientName ?? 'An MCP client')} is asking for a remote shell on this machine. If you started this, run the command below from a terminal that can SSH into the box.</p>
  <div class="code" id="code">${esc(userCode)}</div>
  <div class="cmd"><pre id="cmd">${esc(command)}</pre><button id="copy" type="button">Copy</button></div>
  <p id="status"><span class="dot"></span>Waiting for approval… <span id="left"></span></p>
</main>
<script nonce="${nonce}">
  const rid = ${JSON.stringify(rid)};
  const deadline = Date.now() + ${ttl} * 1000;
  const status = document.getElementById('status');
  const left = document.getElementById('left');

  document.getElementById('copy').addEventListener('click', async e => {
    try { await navigator.clipboard.writeText(document.getElementById('cmd').textContent); e.target.textContent = 'Copied'; }
    catch { e.target.textContent = 'Select & copy'; }
  });

  function stop(text, cls) { status.textContent = text; status.className = cls; }

  async function poll() {
    const secs = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    left.textContent = '(' + secs + 's left)';
    try {
      const r = await fetch('/authorize/status?rid=' + encodeURIComponent(rid), { cache: 'no-store' });
      const body = await r.json();
      if (body.status === 'approved') { stop('Approved — returning to Claude…', 'ok'); location.replace(body.redirect); return; }
      if (body.status === 'denied')   { stop('Denied.', 'bad'); location.replace(body.redirect); return; }
      if (body.status === 'expired')  { stop('This code expired. Go back to Claude and connect again.', 'bad'); return; }
    } catch { /* transient network error: keep polling */ }
    setTimeout(poll, 1500);
  }
  poll();
</script>
</body>
</html>`);
}
