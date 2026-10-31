// SPDX-License-Identifier: AGPL-3.0-only
// What the bank feed card works out from the API's answers (issue #2099).
import { describe, expect, it } from 'vitest';
import type { BankFeedAccountView } from '@crove/kernel-contract';
import type { ChartAccount } from '../src/lib/accounts.ts';
import { bankAccountChoices, bankFeedOffered, feedAccountRows, mappedOf, showsBankFeeds } from '../src/lib/bank-feeds.ts';

const chart = (code: string, rootCode: string, active = true): ChartAccount => ({ code, name: '', parentCode: null, rootCode, active, custom: false });
const mapped = (externalAccountId: string, connectionId = 'c1'): BankFeedAccountView => ({
  id: `m-${externalAccountId}`,
  connectionId,
  provider: 'bank_sandbox',
  connectionName: 'Ngân hàng thử',
  connectionStatus: 'active',
  externalAccountId,
  bankAccount: '1121',
  legalEntityId: 'e1',
  lastSyncedAt: null,
});

describe('bank feed gate', () => {
  it('is off unless the deployment offers an adapter', () => {
    expect(bankFeedOffered({})).toBe(false);
    expect(bankFeedOffered({ bankFeeds: { sandbox: false } })).toBe(false);
    expect(bankFeedOffered({ bankFeeds: { sandbox: true } })).toBe(true);
  });

  it('needs the finance module too', () => {
    expect(showsBankFeeds({ modules: ['finance'], bankFeeds: { sandbox: true } })).toBe(true);
    expect(showsBankFeeds({ modules: ['crm'], bankFeeds: { sandbox: true } })).toBe(false);
    expect(showsBankFeeds({ modules: ['finance'], bankFeeds: { sandbox: false } })).toBe(false);
    expect(showsBankFeeds({ modules: ['finance'] })).toBe(false);
  });
});

describe('bankAccountChoices', () => {
  it('keeps the accounts under 112 but not the 112 group, and the inactive one only while it is chosen', () => {
    const accounts = [chart('111', '111'), chart('112', '112'), chart('1121', '1121'), chart('1121.VCB', '1121'), chart('1121.OLD', '1121', false), chart('331', '331')];
    expect(bankAccountChoices(accounts).map((a) => a.code)).toEqual(['1121', '1121.VCB']);
    expect(bankAccountChoices(accounts, '1121.OLD').map((a) => a.code)).toEqual(['1121', '1121.VCB', '1121.OLD']);
  });
});

describe('feedAccountRows', () => {
  const listed = [
    { externalAccountId: 'SBX-001', displayName: 'Tài khoản 1' },
    { externalAccountId: 'SBX-002', displayName: 'Tài khoản 2' },
  ];

  it('lists the listed accounts with their mapping', () => {
    const rows = feedAccountRows(listed, [mapped('SBX-001')]);
    expect(rows.map((r) => [r.externalAccountId, r.mapped?.id ?? null, r.gone])).toEqual([
      ['SBX-001', 'm-SBX-001', false],
      ['SBX-002', null, false],
    ]);
  });

  it('shows a mapped account the provider no longer lists as gone, after the listed ones', () => {
    const rows = feedAccountRows(listed.slice(1), [mapped('SBX-001')]);
    expect(rows.map((r) => [r.externalAccountId, r.gone])).toEqual([
      ['SBX-002', false],
      ['SBX-001', true],
    ]);
  });

  it('calls nothing gone while the listing is not known', () => {
    const rows = feedAccountRows(null, [mapped('SBX-001')]);
    expect(rows.map((r) => [r.externalAccountId, r.gone])).toEqual([['SBX-001', false]]);
  });

  it('is empty right after connecting, until the first sync', () => {
    expect(feedAccountRows([], [])).toEqual([]);
  });
});

describe('mappedOf', () => {
  it('keeps the mappings of one connection', () => {
    expect(mappedOf([mapped('a', 'c1'), mapped('b', 'c2')], 'c2').map((m) => m.externalAccountId)).toEqual(['b']);
  });
});
