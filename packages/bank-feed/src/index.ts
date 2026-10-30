// SPDX-License-Identifier: AGPL-3.0-only
// Bank feed providers (ADR-0039 point 2): the adapters behind the finance module's bank-feed port. A connection and its
// sealed credential live in the kernel's channel layer (ADR-0025); a provider knows how to list the accounts a
// credential reaches and how to pull an account's transactions since a cursor. Read-only by design: the interface has
// no capability that moves money, and an adapter for a provider that also offers payments implements none of it.
// Each adapter declares the hosts its fetch is bound to; the offline sandbox reaches none.
import { createHash, randomBytes } from 'node:crypto';

export const BANK_FEED_PROVIDERS = ['bank_sandbox'] as const;
export type BankFeedProviderId = (typeof BANK_FEED_PROVIDERS)[number];

export function isBankFeedProvider(value: string): value is BankFeedProviderId {
  return (BANK_FEED_PROVIDERS as readonly string[]).includes(value);
}

// An account a credential reaches, as the provider names it.
export interface BankFeedAccount {
  externalAccountId: string;
  displayName: string;
}

// One transaction as the bank reports it: a signed decimal amount (money in positive), the balance after it when the
// provider gives one, and the bank's own reference (the one statement files print), which is the line's key.
export interface BankFeedTransaction {
  date: string;
  description: string;
  amount: string;
  balance: string | null;
  reference: string;
}

// A pull: the transactions after the cursor, oldest first, the cursor to pull from next time, and whether more are
// waiting beyond this page.
export interface BankFeedPull {
  transactions: BankFeedTransaction[];
  cursor: string;
  more: boolean;
}

// A connected login: the account id the channel connection is keyed by, its name, and the secret the kernel seals.
// `secret` never leaves the server: the caller seals it with the credential broker and drops it.
export interface BankFeedLogin {
  provider: BankFeedProviderId;
  externalAccountId: string;
  displayName: string;
  secret: string;
}

export interface BankFeedProvider {
  readonly id: BankFeedProviderId;
  // The hosts this adapter's fetch is bound to.
  readonly hosts: readonly string[];
  accounts(secret: string): Promise<BankFeedAccount[]>;
  pull(secret: string, externalAccountId: string, cursor: string | null): Promise<BankFeedPull>;
}

// The offline sandbox (ADR-0039): no network, so the connect, map and sync flow runs on a laptop and in tests. Its
// secret is random and sealed like any other, so the credential path is exercised end to end. It reaches two accounts
// and reports, for each day, the same transactions every time it is asked (references derived from the account and
// the day), so overlapping pulls and statement files exercise the dedupe. The cursor is the last day pulled.
const SANDBOX_ACCOUNTS: readonly BankFeedAccount[] = [
  { externalAccountId: 'SBX-001', displayName: 'Sandbox Bank 001' },
  { externalAccountId: 'SBX-002', displayName: 'Sandbox Bank 002' },
];
// Days a pull covers at most, and the days a first pull goes back.
const SANDBOX_PAGE_DAYS = 31;
const SANDBOX_FIRST_DAYS = 7;
const DAY_MS = 86_400_000;
const SECRET = /^sbx_[A-Za-z0-9_-]{43}$/;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

// A day's transactions of one account: a transfer in and, every other day, a fee; amounts from a hash of the account
// and the day, whole VND.
function sandboxDay(account: string, day: string): BankFeedTransaction[] {
  const seed = createHash('sha256').update(`${account}|${day}`).digest();
  const compact = day.replaceAll('-', '');
  const lines: BankFeedTransaction[] = [
    { date: day, description: 'Khach hang chuyen khoan', amount: String(100_000 * (1 + (seed[0] as number))), balance: null, reference: `${account}-${compact}-1` },
  ];
  if ((seed[1] as number) % 2 === 0) lines.push({ date: day, description: 'Phi dich vu', amount: '-11000', balance: null, reference: `${account}-${compact}-2` });
  return lines;
}

export function sandboxBankFeed(now: () => Date = () => new Date()): BankFeedProvider & { connect(displayName: string): BankFeedLogin } {
  const check = (secret: string) => {
    if (!SECRET.test(secret)) throw new Error('sandbox bank feed: invalid secret');
  };
  return {
    id: 'bank_sandbox',
    hosts: [],
    connect(displayName: string): BankFeedLogin {
      const secret = `sbx_${randomBytes(32).toString('base64url')}`;
      // The login is keyed by its secret's hash, so each connect is a login of its own.
      const login = createHash('sha256').update(secret).digest('hex').slice(0, 16);
      return { provider: 'bank_sandbox', externalAccountId: `sandbox-${login}`, displayName, secret };
    },
    async accounts(secret: string): Promise<BankFeedAccount[]> {
      check(secret);
      return [...SANDBOX_ACCOUNTS];
    },
    async pull(secret: string, externalAccountId: string, cursor: string | null): Promise<BankFeedPull> {
      check(secret);
      if (!SANDBOX_ACCOUNTS.some((a) => a.externalAccountId === externalAccountId)) throw new Error('sandbox bank feed: unknown account');
      if (cursor !== null && !/^\d{4}-\d{2}-\d{2}$/.test(cursor)) throw new Error('sandbox bank feed: invalid cursor');
      // Up to yesterday: today's transactions are not final.
      const last = dayMs(isoDay(now().getTime())) - DAY_MS;
      const first = cursor === null ? last - (SANDBOX_FIRST_DAYS - 1) * DAY_MS : dayMs(cursor) + DAY_MS;
      const end = Math.min(last, first + (SANDBOX_PAGE_DAYS - 1) * DAY_MS);
      const transactions: BankFeedTransaction[] = [];
      for (let ms = first; ms <= end; ms += DAY_MS) transactions.push(...sandboxDay(externalAccountId, isoDay(ms)));
      return { transactions, cursor: end >= first ? isoDay(end) : (cursor ?? isoDay(last)), more: end < last };
    },
  };
}
