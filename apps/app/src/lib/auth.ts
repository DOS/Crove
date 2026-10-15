import { AuthClient, type Session } from '@supabase/auth-js';

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
  if (!response.ok) throw new Error('Không tải được cấu hình');
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

const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Email hoặc mật khẩu không đúng',
  user_already_exists: 'Email này đã có tài khoản',
  email_not_confirmed: 'Email chưa được xác nhận, hãy mở thư xác nhận',
  weak_password: 'Mật khẩu quá yếu (tối thiểu 8 ký tự)',
  over_email_send_rate_limit: 'Gửi email quá nhanh, hãy thử lại sau',
};

export function authErrorMessage(error: { code?: string | undefined; message: string } | null): string | null {
  if (!error) return null;
  return (error.code && AUTH_MESSAGES[error.code]) || error.message;
}
