// Connecting an account through the provider's OAuth dialog (Social plan §3.5, step S6.1). The API starts an attempt
// (a single-use state, and a PKCE verifier where the provider supports it), sends the browser to `authorizeUrl`, and
// finishes it with the code the provider hands back: `exchange` turns the code into the accounts the grant covers,
// each with the token the kernel seals. Only the OAuth routes and jobs call connectors; command handlers never do
// network I/O.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { ChannelProviderId, ConnectedAccount } from './index.ts';

export interface AuthorizeInput {
  state: string;
  redirectUri: string;
  // S256 challenge of the attempt's verifier; null when the connector does not use PKCE.
  codeChallenge: string | null;
}

export interface ExchangeInput {
  code: string;
  redirectUri: string;
  codeVerifier: string | null;
}

export interface OAuthConnector {
  readonly provider: ChannelProviderId;
  readonly pkce: boolean;
  authorizeUrl(input: AuthorizeInput): string;
  // The accounts the grant covers (a Facebook login covers every Page the user picked in Meta's dialog). Throws
  // ConnectorError for a provider answer; never puts a token or the code in the error.
  exchange(input: ExchangeInput): Promise<ConnectedAccount[]>;
}

// invalid_grant: the code was refused (used, expired, or issued to another redirect); denied: the user or the app
// lacks a permission the connector needs; provider: the provider failed or answered something unexpected.
export type ConnectorErrorKind = 'invalid_grant' | 'denied' | 'provider';

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind;
  readonly code: string | undefined;
  constructor(kind: ConnectorErrorKind, message: string, code?: string) {
    super(message);
    this.name = 'ConnectorError';
    this.kind = kind;
    this.code = code;
  }
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

// A fresh attempt: the state for the provider, its hash for the database, and a PKCE pair when asked for.
export function newOAuthAttempt(pkce: boolean): { state: string; stateHash: string; codeVerifier: string | null; codeChallenge: string | null } {
  const state = base64url(randomBytes(32));
  const codeVerifier = pkce ? base64url(randomBytes(48)) : null;
  return { state, stateHash: oauthStateHash(state), codeVerifier, codeChallenge: codeVerifier ? base64url(createHash('sha256').update(codeVerifier).digest()) : null };
}

export function oauthStateHash(state: string): string {
  return `sha256:${createHash('sha256').update(state).digest('hex')}`;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// The provider call a job is making (#382): once the job gives up on it (its timeout), every request the adapter still
// makes in that call is aborted, so nothing reaches the platform after the job recorded the outcome as unknown.
const callScope = new AsyncLocalStorage<AbortSignal>();

export function withCallSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return callScope.run(signal, run);
}

// A request's own timeout, joined with the call's signal when there is one.
export function requestSignal(own: AbortSignal): AbortSignal {
  const call = callScope.getStore();
  return call ? AbortSignal.any([own, call]) : own;
}

// fetch limited to the hosts a connector or publisher talks to, with a timeout. A redirect is not followed: an
// allowlisted host could otherwise hand the request (and its bearer token) to another one.
export function allowlistedFetch(hosts: readonly string[], fetchImpl: Fetch = fetch, timeoutMs = 15_000): Fetch {
  const allowed = new Set(hosts);
  return async (input, init) => {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !allowed.has(url.hostname)) throw new Error(`host not allowed for this channel: ${url.hostname}`);
    return fetchImpl(url.toString(), { ...init, redirect: 'manual', signal: requestSignal(init?.signal ?? AbortSignal.timeout(timeoutMs)) });
  };
}
