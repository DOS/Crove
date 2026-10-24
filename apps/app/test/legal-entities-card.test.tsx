// The legal entities card in Settings (issue #1278), rendered on the server with the list answered from a seeded cache:
// the default entity first with its badge, each entity's kind, tax code and parent, and the form to add one.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegalEntity } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';

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

const { LegalEntitiesCard } = await import('../src/routes/legal-entities.tsx');

const at = '2026-10-24T00:00:00.000Z';
const entities: LegalEntity[] = [
  { id: '00000000-0000-7000-8000-000000000001', name: 'Công ty TNHH Mẫu', kind: 'company', taxCode: '0101234564', parentId: null, isDefault: true, createdAt: at, updatedAt: at },
  {
    id: '00000000-0000-7000-8000-000000000002',
    name: 'Chi nhánh Hà Nội',
    kind: 'branch',
    taxCode: null,
    parentId: '00000000-0000-7000-8000-000000000001',
    isDefault: false,
    createdAt: at,
    updatedAt: at,
  },
];

function card(): string {
  const qc = client.current;
  qc.setQueryData(['legalEntities', 'list'], entities);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <LegalEntitiesCard />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('LegalEntitiesCard', () => {
  beforeEach(() => client.current.clear());

  it('lists the default entity with its badge, then the branch under it', () => {
    const html = card();
    const rows = html.split('<li').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Công ty TNHH Mẫu');
    expect(rows[0]).toContain(`>${en.legalEntities.default}<`);
    expect(rows[0]).toContain(en.legalEntities.kinds.company);
    expect(rows[0]).toContain('0101234564');
    expect(rows[1]).toContain('Chi nhánh Hà Nội');
    expect(rows[1]).not.toContain(`>${en.legalEntities.default}<`);
    expect(rows[1]).toContain(en.legalEntities.kinds.branch);
    expect(rows[1]).toContain(en.legalEntities.noTaxCode);
    expect(rows[1]).toContain('Under Công ty TNHH Mẫu');
  });

  it('offers the form to add one, with every kind and every entity as a parent', () => {
    const html = card();
    expect(html).toContain(`aria-label="${en.legalEntities.addTitle}"`);
    for (const kind of Object.values(en.legalEntities.kinds)) expect(html).toContain(`>${kind}<`);
    expect(html).toContain(`>${en.legalEntities.noParent}<`);
    expect(html).toContain('>Công ty TNHH Mẫu (0101234564)<');
    expect(html).toContain('>Chi nhánh Hà Nội<');
  });
});
