import net from 'node:net';
import { ADMIN_SOCKET } from './config.ts';

const HELP = `box-mcp — remote bash for Claude, approved over SSH

  box-mcp approve <CODE>    approve the login showing CODE in your browser
  box-mcp deny <CODE>       reject it
  box-mcp pending           list logins waiting for approval
  box-mcp grants            list active logins (one per connected Claude account)
  box-mcp revoke <id|--all> log a connector out
  box-mcp url               print the URL to paste into Claude's "Add custom connector"
  box-mcp serve             run the server (normally done by systemd)
`;

type Reply = { ok: boolean; error?: string; [k: string]: any };

function call(request: Record<string, unknown>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(ADMIN_SOCKET);
    let buf = '';
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', d => (buf += d));
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error(`Bad reply from server: ${buf}`));
      }
    });
    socket.on('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        code === 'ENOENT' || code === 'ECONNREFUSED'
          ? new Error('box-mcp server is not running (systemctl --user status box-mcp).')
          : err
      );
    });
  });
}

const ago = (seconds: number) => {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
};

function printRequest(r: any) {
  console.log(`  code:    ${r.code}`);
  console.log(`  client:  ${r.client}  →  ${r.redirect}`);
  console.log(`  browser: ${r.ip ?? '?'}  ${r.userAgent ?? ''}`);
  console.log(`  age:     ${ago(r.ageSeconds)}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  switch (cmd) {
    case 'serve':
      await import('./server.ts');
      return;

    case 'approve':
    case 'deny': {
      if (!arg) throw new Error(`Usage: box-mcp ${cmd} <CODE>`);
      const r = await call({ cmd, code: arg });
      if (!r.ok) throw new Error(r.error);
      console.log(cmd === 'approve' ? 'Approved:' : 'Denied:');
      printRequest(r.request);
      return;
    }

    case 'pending': {
      const r = await call({ cmd });
      if (!r.ok) throw new Error(r.error);
      if (r.pending.length === 0) console.log('Nothing waiting for approval.');
      for (const p of r.pending) {
        printRequest(p);
        console.log();
      }
      return;
    }

    case 'grants':
    case 'tokens': {
      const r = await call({ cmd: 'grants' });
      if (!r.ok) throw new Error(r.error);
      if (r.grants.length === 0) console.log('No active logins.');
      for (const g of r.grants) {
        console.log(
          `${g.id}  ${g.clientName ?? g.clientId}  created ${ago(r.now - g.createdAt)} ago · last used ${ago(r.now - g.lastUsedAt)} ago · expires in ${ago(g.expiresAt - r.now)}`
        );
      }
      return;
    }

    case 'revoke': {
      if (!arg) throw new Error('Usage: box-mcp revoke <grant-id|--all>');
      const r = await call({ cmd, id: arg });
      if (!r.ok) throw new Error(r.error);
      console.log(`Revoked ${r.revoked} login(s).`);
      return;
    }

    case 'url': {
      const r = await call({ cmd: 'info' });
      if (!r.ok) throw new Error(r.error);
      console.log(r.mcpUrl);
      return;
    }

    default:
      process.stdout.write(HELP);
      process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h' ? 2 : 0;
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
