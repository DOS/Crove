import { AuthClient, type Session } from '@supabase/auth-js';
import type { Translate } from '../i18n/runtime.ts';
import { ClientError } from './errors.ts';
import { withInviteToken } from './invite.ts';

export interface PublicConfig {
  authUrl: string;
  authAnonKey: string | null;
  aiEnabled: boolean;
  inboundEnabled: boolean;
  // The server mails invites (SMTP configured).
  mailEnabled: boolean;
  // The modules this deployment runs (CROVE_MODULES); kernel is always one of them.
  modules: string[];
  // presigned: files go to the bucket through a staging upload (plan §7.6); direct: through the kernel.
  uploads?: 'presigned' | 'direct';
  // The kernel serves /api/stream (issue #69); without it the screens poll.
  stream?: boolean;
  // The feedback and support link (SUPPORT_URL, issue #310): https: or mailto:, null when the deployment has none.
  supportUrl?: string | null;
  // The server can look up a tax code in the public registry to prefill a new org (TAX_CODE_LOOKUP_URL, issue #324).
  taxCodeLookup?: boolean;
  // The offline sandbox channel can be connected (CHANNEL_SANDBOX); `oauth` lists the providers connected through
  // their OAuth dialog that the server has app credentials for.
  channels?: { sandbox: boolean; bluesky?: boolean; oauth?: string[] };
}

let config: PublicConfig | null = null;
type Client = InstanceType<typeof AuthClient>;
let client: Client | null = null;

export async function loadConfig(): Promise<PublicConfig> {
  if (config) return config;
  const response = await fetch('/api/config');
  if (!response.ok) throw new ClientError('common.configLoadFailed', (t) => t('common.configLoadFailed'));
  config = (await response.json()) as PublicConfig;
  return config;
}

export function getConfig(): PublicConfig {
  if (!config) throw new Error('config not loaded');
  return config;
}

export function auth(): Client {
  if (client) return client;
  const { authUrl, authAnonKey } = getConfig();
  client = new AuthClient({
    url: authUrl,
    headers: authAnonKey ? { apikey: authAnonKey, Authorization: `Bearer ${authAnonKey}` } : {},
    storageKey: 'crove-auth',
    // A sign-up from an accept link carries the invite token for the proxy's sign-up policy (#563).
    fetch: withInviteToken((input, init) => fetch(input, init), window.location.origin),
    // Email links (confirmation, recovery) come back with a one-time code that only this browser can exchange.
    flowType: 'pkce',
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  });
  return client;
}

export async function accessToken(): Promise<string | null> {
  const { data } = await auth().getSession();
  return data.session?.access_token ?? null;
}

// True when the session is signed in with a password only but the user has a verified second factor.
export async function needsSecondFactor(): Promise<boolean> {
  const { data } = await auth().mfa.getAuthenticatorAssuranceLevel();
  return data?.currentLevel === 'aal1' && data.nextLevel === 'aal2';
}

// The same question, asked of the server when the session's answer is no (#345). The session keeps the factors the
// user had when it was issued, so a factor enabled since on another device is missing there until the token refreshes.
// /mfa asks this one: on the cached answer it would send that user back to the app, whose next request the kernel
// refuses with MFA_REQUIRED, which opens /mfa again, page load after page load. For the same reason a failed answer
// throws (the router shows its error page) instead of counting as "no factor".
export async function needsSecondFactorNow(client: Pick<Client, 'mfa'> = auth()): Promise<boolean> {
  const { data, error } = await client.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  if (data?.currentLevel !== 'aal1') return false;
  if (data.nextLevel === 'aal2') return true;
  const factors = await client.mfa.listFactors();
  if (factors.error) throw factors.error;
  return (factors.data?.all ?? []).some((factor) => factor.status === 'verified');
}

export type { Session };

// Supabase Auth error codes with a message of their own; any other error shows the server's message.
const AUTH_ERRORS = [
  'invalid_credentials',
  'user_already_exists',
  'email_not_confirmed',
  'weak_password',
  'same_password',
  'over_email_send_rate_limit',
  'otp_expired',
  'flow_state_expired',
  'flow_state_not_found',
  'bad_code_verifier',
  'mfa_verification_failed',
  'mfa_challenge_expired',
  'insufficient_aal',
  'signup_not_allowed',
  'signup_method_not_allowed',
  'signup_disabled',
] as const;
type AuthErrorCode = (typeof AUTH_ERRORS)[number];

function knownCode(code: string | undefined): AuthErrorCode | null {
  return AUTH_ERRORS.find((c) => c === code) ?? null;
}

// What a screen keeps of a Supabase Auth error: the code when the SPA words it, else the server's message.
// It is put in words at render (authErrorText), so a language switch rewords it.
export type AuthFailure = { code: AuthErrorCode } | { message: string };

export function authFailure(error: { code?: string | undefined; message: string }): AuthFailure {
  const code = knownCode(error.code);
  return code ? { code } : { message: error.message };
}

export function authErrorText(failure: AuthFailure, t: Translate): string {
  return 'code' in failure ? t(`auth.errors.${failure.code}`) : failure.message;
}

// What happened to an email link (confirmation or recovery) the app was opened with, shown once on the sign-in page.
// Kept as a code, so the page shows it in the language it renders in.
export type CallbackNotice = { error: true; code: AuthErrorCode | null } | { error: false };
let callbackNotice: CallbackNotice | null = null;

// Runs once at startup, before the router reads the URL. A failed link lands here with Supabase Auth's error.
// A recovery link always opens the new-password screen, even if Supabase Auth redirected it elsewhere.
export async function settleCallback(): Promise<void> {
  let recovery = false;
  const { data: listener } = auth().onAuthStateChange((event: string) => {
    if (event === 'PASSWORD_RECOVERY') recovery = true;
  });
  const { error } = await auth().initialize();
  listener.subscription.unsubscribe();
  const url = new URL(window.location.href);
  const hadCode = url.searchParams.has('code');
  // The one-time code and any error leave the address bar and history; a leaked code could still be exchanged.
  for (const key of ['code', 'error', 'error_code', 'error_description']) url.searchParams.delete(key);
  if (/(^#|&)(error|error_code|error_description)=/.test(url.hash)) url.hash = '';
  const target = recovery ? '/reset-password' : `${url.pathname}${url.search}${url.hash}`;
  if (target !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, '', target);
  if (error) {
    // The message can come from the link's error_description, which anyone can write: show known codes only.
    callbackNotice = { error: true, code: knownCode((error as { details?: { code?: string } }).details?.code ?? error.code) };
  } else if (hadCode && !(await accessToken())) {
    // Supabase Auth accepted the link, but the one-time code belongs to another browser (PKCE).
    callbackNotice = { error: false };
  }
}

export function peekCallbackNotice(): CallbackNotice | null {
  return callbackNotice;
}

export function callbackNoticeText(notice: CallbackNotice, t: Translate): string {
  if (!notice.error) return t('auth.linkVerified');
  return notice.code ? t(`auth.errors.${notice.code}`) : t('auth.linkInvalid');
}

export function clearCallbackNotice(): void {
  callbackNotice = null;
}
