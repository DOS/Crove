// SPDX-License-Identifier: AGPL-3.0-only
// The bank feed card in Settings (issue #2099), rendered on the server with the API's answers seeded in the cache:
// what an owner and an admin can do, what a member or viewer sees, the accounts read from bankFeeds.listed after a
// sync, the status of each connection and mapped account.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankFeedAccountView, LegalEntity } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import type { ChartAccount } from '../src/lib/accounts.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions() / key(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { BankFeedsCard } = await import('../src/routes/bank-feeds.tsx');

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const at = '2026-10-31T00:00:00.000Z';
const entity = (id: string, name: string, isDefault: boolean): LegalEntity => ({ id, name, kind: 'company', taxCode: null, parentId: null, isDefault, createdAt: at, updatedAt: at });
const chartAccount = (code: string, name: string, rootCode: string): ChartAccount => ({ code, name, parentCode: null, rootCode, active: true, custom: false });
const account = (id: string, externalAccountId: string, over: Partial<BankFeedAccountView> = {}): BankFeedAccountView => ({
  id,
  connectionId: 'c1',
  provider: 'bank_sandbox',
  connectionName: 'Ngân hàng thử',
  connectionStatus: 'active',
  externalAccountId,
  bankAccount: '1121',
  legalEntityId: 'e1',
  lastSyncedAt: null,
  ...over,
});

interface Seed {
  connections?: Array<{ id: string; provider: string; displayName: string; status: 'active' | 'expired' | 'revoked' | 'error'; connectedAt: string }>;
  listed?: Array<{ externalAccountId: string; displayName: string; listedAt: string }>;
  mapped?: BankFeedAccountView[];
  entities?: LegalEntity[];
  locale?: 'en' | 'vi';
}
const connection = (status: 'active' | 'expired' | 'error' = 'active') => ({ id: 'c1', provider: 'bank_sandbox', displayName: 'Ngân hàng thử', status, connectedAt: at });
const listedAccounts = [
  { externalAccountId: 'SBX-001', displayName: 'Tài khoản thanh toán', listedAt: at },
  { externalAccountId: 'SBX-002', displayName: 'Tài khoản tiết kiệm', listedAt: at },
];

function card(role: Role, seed: Seed = {}): string {
  const qc = client.current;
  qc.setQueryData(['bankFeeds', 'accounts'], seed.mapped ?? []);
  qc.setQueryData(['bankFeeds', 'connections'], seed.connections ?? [connection()]);
  qc.setQueryData(['bankFeeds', 'listed'], seed.listed ?? listedAccounts);
  qc.setQueryData(['accounts', 'list'], [chartAccount('111', 'Tiền mặt', '111'), chartAccount('1121', 'Tiền Việt Nam', '1121'), chartAccount('1121.VCB', 'Vietcombank', '1121')]);
  qc.setQueryData(['legalEntities', 'list'], seed.entities ?? [entity('e1', 'Công ty TNHH Mẫu', true)]);
  const locale = seed.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <BankFeedsCard role={role} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('BankFeedsCard for an owner or admin', () => {
  beforeEach(() => client.current.clear());

  it.each<Role>(['owner', 'admin'])('as %s: lists the connection with its status, the connect form and the accounts to map', (role) => {
    const html = card(role);
    expect(html).toContain(`aria-label="${en.bankFeeds.title}"`);
    expect(html).toContain('Ngân hàng thử');
    expect(html).toContain(`>${en.bankFeeds.status.active}<`);
    expect(html).toContain(`aria-label="${en.bankFeeds.connectTitle}"`);
    expect(html).toContain(`>${en.bankFeeds.connect}<`);
    // The accounts come from bankFeeds.listed (the connect answer carries none), each with a map form over the 112 accounts.
    expect(html).toContain('Tài khoản thanh toán');
    expect(html).toContain('Tài khoản tiết kiệm');
    expect(html.match(new RegExp(`>${en.bankFeeds.map}<`, 'g'))).toHaveLength(2);
    expect(html).toContain('>1121 · Tiền Việt Nam<');
    expect(html).toContain('>1121.VCB · Vietcombank<');
    expect(html).not.toContain('>111 · Tiền mặt<');
    // One legal entity: nothing to choose.
    expect(html).not.toContain(`aria-label="${en.bankFeeds.legalEntity}"`);
    expect(html).not.toContain(en.bankFeeds.waiting);
  });

  it('says so while a connection has listed nothing yet, right after connecting', () => {
    const html = card('owner', { listed: [] });
    expect(html).toContain(en.bankFeeds.waiting);
    expect(html).toContain(`>${en.bankFeeds.refresh}<`);
    expect(html).not.toContain(`>${en.bankFeeds.map}<`);
  });

  it('says there is no connection yet, and still offers to connect one', () => {
    const html = card('owner', { connections: [] });
    expect(html).toContain(en.bankFeeds.noConnections);
    expect(html).toContain(`aria-label="${en.bankFeeds.connectTitle}"`);
  });

  it('shows a mapped account with its bank account and when it was last synced, and offers to remap or unmap it', () => {
    const html = card('owner', { mapped: [account('m1', 'SBX-001', { lastSyncedAt: '2026-10-30T08:00:00.000Z' })] });
    expect(html).toContain('Goes to bank account 1121');
    expect(html).toContain('Last synced');
    expect(html).toContain(`>${en.bankFeeds.remap}<`);
    expect(html).toContain(`>${en.bankFeeds.unmap}<`);
    // The other account is not mapped yet, and has not been synced.
    expect(html.match(new RegExp(`>${en.bankFeeds.map}<`, 'g'))).toHaveLength(1);
  });

  it('says a mapped account never pulled has not been synced', () => {
    expect(card('owner', { mapped: [account('m1', 'SBX-001')] })).toContain(en.bankFeeds.neverSynced);
  });

  it('shows a mapped account the provider no longer lists as such, with only an unmap', () => {
    const html = card('owner', { listed: listedAccounts.slice(1), mapped: [account('m1', 'SBX-001')] });
    expect(html).toContain(en.bankFeeds.gone);
    expect(html).toContain(`aria-label="${en.bankFeeds.unmapOf.replace('{name}', 'SBX-001')}"`);
    expect(html).not.toContain(`aria-label="${en.bankFeeds.mapForm.replace('{name}', 'SBX-001')}"`);
  });

  it('asks an expired connection to be connected again, and cannot map to it', () => {
    const html = card('owner', { connections: [connection('expired')] });
    expect(html).toContain(`>${en.bankFeeds.status.expired}<`);
    expect(html).toContain(en.bankFeeds.expiredHint);
    expect(html).toContain('disabled=""');
  });

  it('offers the legal entity choice only to an org with several, and locks it on a mapped account', () => {
    const entities = [entity('e1', 'Công ty TNHH Mẫu', true), entity('e2', 'Chi nhánh Hà Nội', false)];
    const html = card('owner', { entities, mapped: [account('m1', 'SBX-001')] });
    expect(html.match(new RegExp(`aria-label="${en.bankFeeds.legalEntity}"`, 'g'))).toHaveLength(2);
    expect(html).toContain('>Chi nhánh Hà Nội<');
    expect(html).toContain(`title="${en.bankFeeds.entityLocked}"`);
  });

  it('has words for the whole card in both languages and offers nothing to pay', () => {
    const inVi = card('owner', { locale: 'vi', mapped: [account('m1', 'SBX-001')] });
    expect(inVi).toContain(viMessages.bankFeeds.title);
    expect(inVi).toContain(`>${viMessages.bankFeeds.status.active}<`);
    expect(inVi).toContain(`>${viMessages.bankFeeds.unmap}<`);
    for (const html of [card('owner'), inVi]) expect(html).not.toMatch(/chuyển tiền<|Pay<|Transfer</);
  });
});

describe('BankFeedsCard for a member or viewer', () => {
  beforeEach(() => client.current.clear());

  it.each<Role>(['member', 'viewer'])('as %s: only reads which accounts are mapped, with nothing to change', (role) => {
    const html = card(role, { mapped: [account('m1', 'SBX-001', { lastSyncedAt: '2026-10-30T08:00:00.000Z' })] });
    expect(html).toContain(en.bankFeeds.readOnlyIntro);
    expect(html).toContain('Ngân hàng thử');
    // The provider's account number is for those who map it.
    expect(html).not.toContain('SBX-001');
    expect(html).toContain('Goes to bank account 1121');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<select');
    expect(html).not.toContain(en.bankFeeds.connectTitle);
  });

  it.each<Role>(['member', 'viewer'])('as %s: draws nothing when no account is mapped', (role) => {
    expect(card(role, { mapped: [] })).toBe('');
  });
});
