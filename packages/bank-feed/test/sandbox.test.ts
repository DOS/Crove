// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox bank feed (ADR-0039): its logins, accounts and pulls, the same transactions for a day every time,
// pages and the cursor, and the refusals.
import { describe, expect, it } from 'vitest';
import { BANK_FEED_PROVIDERS, isBankFeedProvider, sandboxBankFeed } from '../src/index.ts';

const at = (iso: string) => () => new Date(iso);

describe('the sandbox bank feed', () => {
  it('connects a login of its own each time, with a secret the kernel seals', () => {
    const feed = sandboxBankFeed();
    const a = feed.connect('Ngân hàng thử');
    const b = feed.connect('Ngân hàng thử');
    expect(a).toMatchObject({ provider: 'bank_sandbox', displayName: 'Ngân hàng thử' });
    expect(a.externalAccountId).toMatch(/^sandbox-[0-9a-f]{16}$/);
    expect(a.externalAccountId).not.toBe(b.externalAccountId);
    expect(a.secret).not.toBe(b.secret);
    expect(feed.hosts).toEqual([]);
    expect(BANK_FEED_PROVIDERS).toContain(feed.id);
    expect(isBankFeedProvider('bank_sandbox')).toBe(true);
    expect(isBankFeedProvider('sandbox')).toBe(false);
  });

  it('lists its accounts, and pulls the week before today first, then from the cursor on', async () => {
    const feed = sandboxBankFeed(at('2026-11-10T08:00:00Z'));
    const { secret } = feed.connect('Thử');
    expect((await feed.accounts(secret)).map((a) => a.externalAccountId)).toEqual(['SBX-001', 'SBX-002']);
    const first = await feed.pull(secret, 'SBX-001', null);
    expect(first.cursor).toBe('2026-11-09');
    expect(first.more).toBe(false);
    expect(new Set(first.transactions.map((t) => t.date))).toEqual(new Set(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']));
    expect(first.transactions.every((t) => t.reference.startsWith('SBX-001-') && !/^-?0$/.test(t.amount))).toBe(true);
    // Nothing new until a day has passed.
    expect(await feed.pull(secret, 'SBX-001', first.cursor)).toEqual({ transactions: [], cursor: '2026-11-09', more: false });
    // A day later, that day alone; and the same transactions as any other pull of it.
    const next = await sandboxBankFeed(at('2026-11-11T08:00:00Z')).pull(secret, 'SBX-001', first.cursor);
    expect(new Set(next.transactions.map((t) => t.date))).toEqual(new Set(['2026-11-10']));
    expect((await sandboxBankFeed(at('2026-11-11T08:00:00Z')).pull(secret, 'SBX-001', '2026-11-09')).transactions).toEqual(next.transactions);
  });

  it('pages a long gap 31 days at a time', async () => {
    const feed = sandboxBankFeed(at('2026-11-10T08:00:00Z'));
    const { secret } = feed.connect('Thử');
    const page = await feed.pull(secret, 'SBX-002', '2026-08-31');
    expect(page).toMatchObject({ cursor: '2026-10-01', more: true });
    expect(await feed.pull(secret, 'SBX-002', page.cursor)).toMatchObject({ cursor: '2026-11-01', more: true });
  });

  it('refuses a secret it did not issue, an account it does not reach and a bad cursor', async () => {
    const feed = sandboxBankFeed();
    const { secret } = feed.connect('Thử');
    await expect(feed.accounts('stolen')).rejects.toThrow(/invalid secret/);
    await expect(feed.pull(secret, 'SBX-999', null)).rejects.toThrow(/unknown account/);
    await expect(feed.pull(secret, 'SBX-001', 'yesterday')).rejects.toThrow(/invalid cursor/);
  });
});
