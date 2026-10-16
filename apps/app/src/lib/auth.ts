import { AuthClient, type Session } from '@supabase/auth-js';
import { translator, type Translate } from '../i18n/runtime.ts';

export interface PublicConfig {
  authUrl: string;
  authAnonKey: string | null;
  aiEnabled: boolean;
  inboundEnabled: boolean;
  // The server mails invites (SMTP configured).
  mailEnabled: boolean;
}

let config: PublicConfig | null = null;
type Client = InstanceType<typeof AuthClient>;
let client: Client | null = null;

export async function loadConfig(): Promise<PublicConfig> {
  if (config) return config;
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error(translator()('common.configLoadFailed'));
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

export type { Session };

// Supabase Auth error codes with a message of their own; any other error shows the server's message.
const AUTH_ERRORS = ['invalid_credentials', 'user_already_exists', 'email_not_confirmed', 'weak_password', 'over_email_send_rate_limit'] as const;
type AuthErrorCode = (typeof AUTH_ERRORS)[number];

export function authErrorMessage(error: { code?: string | undefined; message: string } | null, t: Translate): string | null {
  if (!error) return null;
  const code = AUTH_ERRORS.find((c): c is AuthErrorCode => c === error.code);
  return code ? t(`auth.errors.${code}`) : error.message;
}
