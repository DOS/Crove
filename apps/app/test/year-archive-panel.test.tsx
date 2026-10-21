// The fiscal year archive panel on the ledger screen (issue #922), rendered on the server with the queries answered
// from a seeded cache: owners see the years they may archive and every package, other roles see nothing.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    queryClient: client.current,
    apiFetch: () => Promise.reject(new Error('not fetched')),
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const { YearArchivePanel } = await import('../src/components/year-archive.tsx');

const recent = new Date(Date.now() - 5 * 60_000).toISOString();
const archives = {
  lockedThrough: '2025-12-31',
  archives: [
    { year: 2025, state: 'requested', requestedAt: recent, builtAt: null, manifestSha256: null, parts: null, documents: null },
    { year: 2024, state: 'built', requestedAt: null, builtAt: '2025-01-15T03:00:00Z', manifestSha256: 'a'.repeat(64), parts: 27, documents: 14 },
  ],
};

function panel(role: string | null, list: unknown = archives): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['org', 'get'], { role, members: [] });
  qc.setQueryData(['yearArchive', 'list'], list);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={en as never}>
        <YearArchivePanel />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('YearArchivePanel', () => {
  beforeEach(() => client.current.clear());

  it('shows nothing to roles other than owner', () => {
    for (const role of ['admin', 'member', 'viewer', null]) expect(panel(role)).toBe('');
  });

  it('offers the newest locked year not built or in progress, and lists every package', () => {
    const html = panel('owner');
    expect(html).toContain(`>${en.yearArchive.title}<`);
    // 2025 is in progress and 2024 is built: the first year offered is 2023.
    expect(html).toContain('>Archive 2023<');
    expect(html).not.toContain('>Archive 2025<');
    expect(html).toContain(`>${en.yearArchive.pending}<`);
    expect(html).toContain(`>${en.yearArchive.built}<`);
    expect(html).toContain('27 files, 14 original documents');
    expect(html).toContain(`>${en.yearArchive.verify}<`);
  });

  it('explains that no year can be archived before a whole year is locked', () => {
    const html = panel('owner', { lockedThrough: null, archives: [] });
    expect(html).toContain(`>${en.yearArchive.noLockedYear}<`);
    expect(html).not.toContain('>Archive ');
  });
});
