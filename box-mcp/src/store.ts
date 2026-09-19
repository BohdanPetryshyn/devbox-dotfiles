import fs from 'node:fs';
import path from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { STATE_DIR, STATE_FILE } from './config.ts';

/** One SSH-approved login. Tokens hang off it; revoking the grant kills them all. */
export type Grant = {
  id: string;
  clientId: string;
  clientName?: string;
  createdAt: number;
  lastUsedAt: number;
  /** Sliding expiry (epoch seconds) — pushed out on every refresh. */
  expiresAt: number;
  scopes: string[];
  resource?: string;
  approvedFrom?: { ip?: string; userAgent?: string };
};

export type TokenRecord = {
  grantId: string;
  expiresAt: number;
  /** Refresh tokens only: when this token was rotated out. */
  supersededAt?: number;
};

type State = {
  clients: Record<string, OAuthClientInformationFull>;
  grants: Record<string, Grant>;
  /** Keyed by sha256(token) — raw tokens are never written to disk. */
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
};

const empty = (): State => ({ clients: {}, grants: {}, accessTokens: {}, refreshTokens: {} });

export const now = () => Math.floor(Date.now() / 1000);

/** Tiny JSON-file store. Single process, single user: load once, rewrite atomically on change. */
export class Store {
  state: State;

  constructor() {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(STATE_DIR, 0o700);
    this.state = empty();
    if (fs.existsSync(STATE_FILE)) {
      this.state = { ...empty(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    }
    this.prune();
  }

  save() {
    this.prune();
    const tmp = path.join(STATE_DIR, `.state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  }

  /** Drops expired tokens/grants, and clients that never completed a login. */
  private prune() {
    const t = now();
    const s = this.state;
    for (const [id, g] of Object.entries(s.grants)) if (g.expiresAt <= t) delete s.grants[id];
    for (const table of [s.accessTokens, s.refreshTokens]) {
      for (const [hash, rec] of Object.entries(table)) {
        if (rec.expiresAt <= t || !s.grants[rec.grantId]) delete table[hash];
      }
    }
    const inUse = new Set(Object.values(s.grants).map(g => g.clientId));
    for (const [id, c] of Object.entries(s.clients)) {
      const age = t - (c.client_id_issued_at ?? 0);
      if (!inUse.has(id) && age > 24 * 60 * 60) delete s.clients[id];
    }
  }

  revokeGrant(grantId: string): boolean {
    if (!this.state.grants[grantId]) return false;
    delete this.state.grants[grantId];
    this.save(); // prune() sweeps the orphaned tokens
    return true;
  }

  revokeAll(): number {
    const n = Object.keys(this.state.grants).length;
    this.state.grants = {};
    this.save();
    return n;
  }
}
