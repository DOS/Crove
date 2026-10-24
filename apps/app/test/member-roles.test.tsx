// A member's roles in Settings (issue #1279), rendered on the server: the roles a member holds (an entity role with its
// entity), the revoke and assign controls only for owners, and which roles an owner may still give.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { LegalEntity, MemberRoles } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { assignableRoles, roleNeedsEntity } from '../src/lib/member-roles.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false };
});

const { MemberRolesRow } = await import('../src/routes/member-roles.tsx');

const at = '2026-10-24T00:00:00.000Z';
const member = '00000000-0000-7000-8000-0000000000a1';
const branch = '00000000-0000-7000-8000-000000000002';
const entities: LegalEntity[] = [
  { id: '00000000-0000-7000-8000-000000000001', name: 'Công ty TNHH Mẫu', kind: 'company', taxCode: '0101234564', parentId: null, isDefault: true, createdAt: at, updatedAt: at },
  { id: branch, name: 'Chi nhánh Hà Nội', kind: 'branch', taxCode: null, parentId: null, isDefault: false, createdAt: at, updatedAt: at },
];
const data: MemberRoles = {
  roles: [
    { key: 'finance.chief_accountant', scope: 'org', permissions: ['finance.period.unlock', 'finance.proposal.approve'] },
    { key: 'finance.accountant', scope: 'org', permissions: [] },
    { key: 'external_accountant', scope: 'legal_entity', permissions: [] },
  ],
  assignments: [
    { id: '00000000-0000-7000-8000-0000000000b1', userId: member, roleKey: 'finance.chief_accountant', legalEntityId: null, grantedAt: at },
    { id: '00000000-0000-7000-8000-0000000000b2', userId: member, roleKey: 'external_accountant', legalEntityId: branch, grantedAt: at },
  ],
};

const row = (isOwner: boolean, userId = member) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <MemberRolesRow userId={userId} name="Lan" baseRole="member" data={data} entities={entities} isOwner={isOwner} />
      </IntlProvider>
    </QueryClientProvider>,
  );

describe('MemberRolesRow', () => {
  it('shows the roles the member holds, an entity role with its entity, and owner controls', () => {
    const html = row(true);
    expect(html).toContain(`>${en.memberRoles.roles.finance.chief_accountant}<`);
    expect(html).toContain(`>${en.memberRoles.roles.external_accountant} (Chi nhánh Hà Nội)<`);
    expect(html.split(`>${en.memberRoles.revoke}<`)).toHaveLength(3);
    expect(html).toContain(`aria-label="Give a role to Lan"`);
  });

  it('shows admins the roles without any control, and nothing for a member without roles', () => {
    const html = row(false);
    expect(html).toContain(`>${en.memberRoles.roles.finance.chief_accountant}<`);
    expect(html).not.toContain(`>${en.memberRoles.revoke}<`);
    expect(html).not.toContain('Give a role');
    expect(row(false, '00000000-0000-7000-8000-0000000000a2')).toBe('');
  });
});

describe('assignableRoles', () => {
  it('offers the roles not held yet, an entity role again, and no entity role to owners and admins', () => {
    const held = data.assignments;
    expect(assignableRoles(data.roles, held, 'member').map((r) => r.key)).toEqual(['finance.accountant', 'external_accountant']);
    expect(assignableRoles(data.roles, [], 'admin').map((r) => r.key)).toEqual(['finance.chief_accountant', 'finance.accountant']);
    expect(roleNeedsEntity({ scope: 'legal_entity' })).toBe(true);
    expect(roleNeedsEntity({ scope: 'org' })).toBe(false);
  });

  it('has a Vietnamese name and hint for every built-in role', () => {
    for (const messages of [en, viMessages]) {
      expect(Object.keys(messages.memberRoles.roles).sort()).toEqual(['crm', 'desk', 'external_accountant', 'finance', 'hr']);
      expect(Object.keys(messages.memberRoles.hints).sort()).toEqual(['crm', 'desk', 'external_accountant', 'finance', 'hr']);
    }
    expect(viMessages.memberRoles.roles.finance.chief_accountant).toBe('Kế toán trưởng');
  });
});
