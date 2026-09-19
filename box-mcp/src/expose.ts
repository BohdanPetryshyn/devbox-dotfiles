// `box-mcp expose | unexpose | status`: everything between "bootstrap finished"
// and "paste this URL into Claude", in one idempotent command. Nothing runs and
// nothing is reachable until `expose` is called.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { PORT } from './config.ts';

const UNIT = 'box-mcp';
const FUNNEL_PORT = '443';

type ServeConfig = {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

export type FunnelState =
  | { kind: 'free' } // nothing on :443 — ours to take
  | { kind: 'ours'; public: boolean } // already proxying to box-mcp
  | { kind: 'taken'; by: string }; // something else lives there; don't clobber it

/** What is `tailscale serve`/`funnel` doing on :443 right now? */
export function funnelState(config: ServeConfig, port: number): FunnelState {
  const entry = Object.entries(config.Web ?? {}).find(([hostPort]) => hostPort.endsWith(`:${FUNNEL_PORT}`));
  const handlers = Object.entries(entry?.[1].Handlers ?? {});
  if (!entry || handlers.length === 0) return { kind: 'free' };

  const ours = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const foreign = handlers.filter(([path, h]) => !(path === '/' && ours.has(h.Proxy ?? '')));
  if (foreign.length > 0) return { kind: 'taken', by: foreign.map(([path, h]) => `${path} → ${h.Proxy ?? '(non-proxy handler)'}`).join(', ') };
  return { kind: 'ours', public: Boolean(config.AllowFunnel?.[entry[0]]) };
}

// --- small process helpers -------------------------------------------------------

function capture(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Runs with the terminal attached, so sudo can prompt and Tailscale can print its enable link. */
function interactive(cmd: string, args: string[]): boolean {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  return spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
}

const step = (msg: string) => console.log(`\n▸ ${msg}`);

function tailscale(): { running: boolean; dnsName: string; serve: ServeConfig; operator: string } {
  const status = capture('tailscale', ['status', '--json', '--peers=false']);
  if (!status.ok) return { running: false, dnsName: '', serve: {}, operator: '' };
  const parsed = JSON.parse(status.out);
  const serve = capture('tailscale', ['serve', 'status', '--json']);
  const prefs = capture('tailscale', ['debug', 'prefs']);
  return {
    running: parsed.BackendState === 'Running',
    dnsName: String(parsed.Self?.DNSName ?? '').replace(/\.$/, ''),
    serve: serve.ok && serve.out ? JSON.parse(serve.out) : {},
    operator: prefs.ok ? (JSON.parse(prefs.out).OperatorUser ?? '') : ''
  };
}

const serviceState = () => ({
  active: capture('systemctl', ['--user', 'is-active', UNIT]).out === 'active',
  enabled: capture('systemctl', ['--user', 'is-enabled', UNIT]).out === 'enabled'
});

// --- commands ----------------------------------------------------------------------

export async function expose(getUrl: () => Promise<string>): Promise<void> {
  const user = os.userInfo().username;

  step('Checking Tailscale');
  const ts = tailscale();
  if (!ts.running) throw new Error('Tailscale is not connected. Run `sudo tailscale up` first, then `box-mcp expose` again.');
  console.log(`  connected as ${ts.dnsName}`);

  const state = funnelState(ts.serve, PORT);
  if (state.kind === 'taken') {
    throw new Error(`Tailscale is already serving something else on :${FUNNEL_PORT} (${state.by}).\nFree it with \`tailscale serve reset\`, or move that service to another port.`);
  }

  if (ts.operator !== user) {
    step(`Letting ${user} manage Tailscale serve/funnel without sudo`);
    if (!interactive('sudo', ['tailscale', 'set', `--operator=${user}`])) throw new Error('Could not set the Tailscale operator.');
  }

  if (!capture('loginctl', ['show-user', user, '-p', 'Linger']).out.includes('yes')) {
    step('Keeping the service alive without a login session (systemd lingering)');
    if (!interactive('sudo', ['loginctl', 'enable-linger', user])) throw new Error('Could not enable lingering.');
  }

  step('Starting the box-mcp service');
  capture('systemctl', ['--user', 'daemon-reload']);
  const started = capture('systemctl', ['--user', 'enable', '--now', UNIT]);
  if (!started.ok) throw new Error(`systemctl --user enable --now ${UNIT} failed:\n${started.out}`);

  if (state.kind === 'ours' && state.public) {
    step('Tailscale Funnel is already pointing at box-mcp');
  } else {
    step('Opening Tailscale Funnel (public HTTPS → this service, nothing else)');
    console.log('  If Funnel was never enabled on this tailnet, a link appears below: open it,\n  approve, and this command continues by itself.');
    if (!interactive('tailscale', ['funnel', '--bg', String(PORT)])) throw new Error('tailscale funnel failed.');
  }

  let url = '';
  for (let i = 0; i < 20 && !url; i++) {
    url = await getUrl().catch(() => '');
    if (!url) await new Promise(r => setTimeout(r, 500));
  }
  if (!url) throw new Error(`The service did not come up — check: journalctl --user -u ${UNIT} -n 30`);

  const host = os.hostname().split('.')[0];
  console.log(`
✔ box-mcp is live.

  1. Claude → Settings → Connectors → Add custom connector
       Name:  ${host}
       URL:   ${url}
  2. Click Connect. The page shows a one-time code — approve it from a terminal:
       ssh ${host} box-mcp approve <CODE>
  3. In the connector's tool permissions set "bash" to ask every time.

  One approval covers every device on that Claude account.
  (The first request can take ~10 s while Tailscale fetches the TLS certificate.)

  Turn it off again:  box-mcp unexpose      Log connectors out:  box-mcp revoke --all
`);
}

export async function unexpose(revokeAll?: () => Promise<number>): Promise<void> {
  if (revokeAll) {
    step('Logging every connector out');
    const n = await revokeAll().catch(() => 0);
    console.log(`  revoked ${n} login(s)`);
  }

  const ts = tailscale();
  const state = funnelState(ts.serve, PORT);
  if (state.kind === 'ours') {
    step('Closing Tailscale Funnel');
    if (!interactive('tailscale', ['funnel', `--https=${FUNNEL_PORT}`, 'off'])) throw new Error('Could not turn Funnel off.');
  } else if (state.kind === 'taken') {
    console.log(`\n▸ Leaving Tailscale's :${FUNNEL_PORT} config alone — it isn't box-mcp's (${state.by}).`);
  }

  step('Stopping the box-mcp service');
  capture('systemctl', ['--user', 'disable', '--now', UNIT]);
  console.log('\n✔ Off: nothing is reachable and nothing is running.');
  if (!revokeAll) console.log('  Logins are kept, so `box-mcp expose` resumes without a new approval (use `unexpose --revoke` to drop them).');
}

export async function status(getGrants: () => Promise<number>): Promise<void> {
  const svc = serviceState();
  const ts = tailscale();
  const state = funnelState(ts.serve, PORT);
  const funnel =
    state.kind === 'ours' ? (state.public ? 'public (Funnel on)' : 'tailnet only (serve, not Funnel)') : state.kind === 'taken' ? `:${FUNNEL_PORT} used by something else (${state.by})` : 'off';

  console.log(`service:  ${svc.active ? 'running' : 'stopped'}${svc.enabled ? ', starts at boot' : ''}`);
  console.log(`funnel:   ${ts.running ? funnel : 'Tailscale not connected'}`);
  if (svc.active && ts.dnsName) console.log(`url:      https://${ts.dnsName}/mcp`);
  if (svc.active) console.log(`logins:   ${await getGrants().catch(() => '?')}`);
  if (!svc.active && state.kind !== 'ours') console.log('\nRun `box-mcp expose` to turn it on.');
}
