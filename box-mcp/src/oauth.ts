import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  ACCESS_TOKEN_TTL,
  ALLOWED_REDIRECT_URIS,
  AUTH_CODE_TTL,
  MAX_PENDING,
  PENDING_TTL,
  REFRESH_GRACE,
  REFRESH_TOKEN_TTL
} from './config.ts';
import { renderAuthorizePage } from './authorize-page.ts';
import { now, Store, type Grant } from './store.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

// No 0/O, 1/I/L, U: the code is read off one screen and typed into another.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const newUserCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
export const formatUserCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
export const normalizeUserCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A login waiting for `box-mcp approve <code>`. Memory only — a restart just means "try again". */
export type Pending = {
  /** Secret handle held by the browser tab that started the flow; used for polling. */
  rid: string;
  userCode: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
  ip?: string;
  userAgent?: string;
  status: 'pending' | 'approved' | 'denied';
};

type AuthCode = {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
  approvedFrom: Grant['approvedFrom'];
};

export type PollResult = { status: 'pending' | 'expired' } | { status: 'approved' | 'denied'; redirect: string };

export class BoxOAuthProvider implements OAuthServerProvider {
  private pending = new Map<string, Pending>(); // by rid
  private codes = new Map<string, AuthCode>(); // by sha256(code)
  private store: Store;
  private resourceUrl: URL;

  constructor(store: Store, resourceUrl: URL) {
    this.store = store;
    this.resourceUrl = resourceUrl;
  }

  // --- clients (dynamic registration) -----------------------------------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: id => this.store.state.clients[id],
      registerClient: client => {
        const bad = client.redirect_uris.filter(u => !ALLOWED_REDIRECT_URIS.includes(u));
        if (client.redirect_uris.length === 0 || bad.length > 0) {
          throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad.join(', ') || '(none given)'}`);
        }
        const full = client as OAuthClientInformationFull;
        this.store.state.clients[full.client_id] = full;
        this.store.save();
        return full;
      }
    };
  }

  // --- /authorize → code page → SSH approval -----------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    this.sweep();
    // Evict the oldest rather than refuse: a flood of bogus requests then can't lock the owner out.
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);

    const p: Pending = {
      rid: newToken(),
      userCode: newUserCode(),
      client,
      params,
      createdAt: now(),
      ip: res.req.ip,
      userAgent: res.req.get('user-agent')?.slice(0, 200),
      status: 'pending'
    };
    this.pending.set(p.rid, p);
    renderAuthorizePage(res, { rid: p.rid, userCode: formatUserCode(p.userCode), clientName: client.client_name, ttl: PENDING_TTL });
  }

  /** Polled by the /authorize page. Hands out the redirect exactly once. */
  poll(rid: string): PollResult {
    this.sweep();
    const p = this.pending.get(rid);
    if (!p) return { status: 'expired' };
    if (p.status === 'pending') return { status: 'pending' };

    this.pending.delete(rid);
    const url = new URL(p.params.redirectUri);
    if (p.params.state) url.searchParams.set('state', p.params.state);
    if (p.status === 'denied') {
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('error_description', 'The request was denied on the box.');
      return { status: 'denied', redirect: url.href };
    }
    const code = newToken();
    this.codes.set(sha256(code), {
      clientId: p.client.client_id,
      params: p.params,
      expiresAt: now() + AUTH_CODE_TTL,
      approvedFrom: { ip: p.ip, userAgent: p.userAgent }
    });
    url.searchParams.set('code', code);
    return { status: 'approved', redirect: url.href };
  }

  // --- admin (reached only through the unix socket, i.e. by someone with a shell) --

  listPending(): Pending[] {
    this.sweep();
    return [...this.pending.values()].filter(p => p.status === 'pending');
  }

  decide(userCode: string, decision: 'approved' | 'denied'): Pending | undefined {
    this.sweep();
    const wanted = normalizeUserCode(userCode);
    const p = [...this.pending.values()].find(x => x.status === 'pending' && x.userCode === wanted);
    if (p) p.status = decision;
    return p;
  }

  // --- /token -------------------------------------------------------------------

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.lookupCode(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const code = this.lookupCode(client, authorizationCode);
    this.codes.delete(sha256(authorizationCode)); // single use
    if (redirectUri !== undefined && redirectUri !== code.params.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    this.checkResource(resource);

    const t = now();
    const grant: Grant = {
      id: randomBytes(6).toString('hex'),
      clientId: client.client_id,
      clientName: client.client_name,
      createdAt: t,
      lastUsedAt: t,
      expiresAt: t + REFRESH_TOKEN_TTL,
      scopes: code.params.scopes ?? [],
      resource: (resource ?? code.params.resource)?.href,
      approvedFrom: code.approvedFrom
    };
    this.store.state.grants[grant.id] = grant;
    return this.issueTokens(grant);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const t = now();
    const rec = this.store.state.refreshTokens[sha256(refreshToken)];
    const grant = rec && this.store.state.grants[rec.grantId];
    if (!rec || !grant || rec.expiresAt <= t || grant.expiresAt <= t || grant.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token is invalid or expired');
    }
    this.checkResource(resource);

    // Rotate. The old token stays valid for REFRESH_GRACE so that two devices
    // refreshing at the same moment both succeed instead of forcing a relogin.
    if (rec.supersededAt === undefined) {
      rec.supersededAt = t;
      rec.expiresAt = t + REFRESH_GRACE;
    }
    grant.expiresAt = t + REFRESH_TOKEN_TTL;
    grant.lastUsedAt = t;
    return this.issueTokens(grant);
  }

  private issueTokens(grant: Grant): OAuthTokens {
    const t = now();
    const access = newToken();
    const refresh = newToken();
    this.store.state.accessTokens[sha256(access)] = { grantId: grant.id, expiresAt: t + ACCESS_TOKEN_TTL };
    this.store.state.refreshTokens[sha256(refresh)] = { grantId: grant.id, expiresAt: t + REFRESH_TOKEN_TTL };
    this.store.save();
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refresh,
      scope: grant.scopes.join(' ') || undefined
    };
  }

  // --- bearer verification & revocation ----------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = now();
    const rec = this.store.state.accessTokens[sha256(token)];
    const grant = rec && this.store.state.grants[rec.grantId];
    if (!rec || !grant || rec.expiresAt <= t || grant.expiresAt <= t) {
      throw new InvalidTokenError('Access token is invalid or expired');
    }
    grant.lastUsedAt = t; // persisted with the next save; not worth a disk write per request
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: rec.expiresAt,
      resource: grant.resource ? new URL(grant.resource) : undefined,
      extra: { grantId: grant.id }
    };
  }

  /** Claude calls this when the connector is disconnected: drop the whole login. */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = sha256(request.token);
    const rec = this.store.state.accessTokens[hash] ?? this.store.state.refreshTokens[hash];
    const grant = rec && this.store.state.grants[rec.grantId];
    if (grant && grant.clientId === client.client_id) this.store.revokeGrant(grant.id);
  }

  // --- helpers ------------------------------------------------------------------

  private lookupCode(client: OAuthClientInformationFull, authorizationCode: string): AuthCode {
    const code = this.codes.get(sha256(authorizationCode));
    if (!code || code.expiresAt <= now() || code.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code is invalid or expired');
    }
    return code;
  }

  /** RFC 8707: if the client names a resource, it has to be this server. */
  private checkResource(resource?: URL) {
    if (resource && resource.origin !== this.resourceUrl.origin) {
      throw new InvalidTargetError(`Unknown resource: ${resource.href}`);
    }
  }

  private sweep() {
    const t = now();
    for (const [rid, p] of this.pending) if (p.createdAt + PENDING_TTL <= t) this.pending.delete(rid);
    for (const [hash, c] of this.codes) if (c.expiresAt <= t) this.codes.delete(hash);
  }
}
