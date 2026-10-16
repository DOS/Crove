// Channel providers (ADR-0025 decision 3, Social plan §3.6). The kernel keeps connections and sealed tokens; a
// provider knows how to connect an account and, from later steps on, how to publish, reconcile and read metrics.
// Each capability is its own small interface, added by the step that first needs it.
import { randomBytes } from 'node:crypto';

export const CHANNEL_PROVIDERS = [
  'sandbox',
  'facebook_page',
  'instagram',
  'zalo_oa',
  'tiktok',
  'youtube',
  'threads',
  'linkedin',
  'x',
  'bluesky',
] as const;
export type ChannelProviderId = (typeof CHANNEL_PROVIDERS)[number];

export function isChannelProvider(value: string): value is ChannelProviderId {
  return (CHANNEL_PROVIDERS as readonly string[]).includes(value);
}

// An account a provider connected, with the tokens the kernel seals. `secret` never leaves the server: the
// caller seals it with the credential broker and drops it.
export interface ConnectedAccount {
  provider: ChannelProviderId;
  externalAccountId: string;
  displayName: string;
  scopes: string[];
  // When the access token expires, if the provider says; null when it does not expire on a timer.
  expiresAt: Date | null;
  secret: string;
}

// The offline sandbox (Social plan §3.5): no network, so the whole flow runs on a laptop and in tests. Its token is
// random, and it is sealed and stored like any other, so the credential path is exercised end to end. The account
// id derives from a caller-chosen key, so connecting again with the same key reconnects the same account.
export const sandbox = {
  id: 'sandbox' as const,
  connect(input: { key: string; displayName: string }): ConnectedAccount {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(input.key)) throw new Error('invalid sandbox account key');
    return {
      provider: 'sandbox',
      externalAccountId: `sandbox-${input.key.toLowerCase()}`,
      displayName: input.displayName,
      scopes: ['publish'],
      expiresAt: null,
      secret: JSON.stringify({ accessToken: `sbx_${randomBytes(24).toString('base64url')}` }),
    };
  },
};
