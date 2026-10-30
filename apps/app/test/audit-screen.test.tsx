// The audit log screen (#672) with command labels (#1654), rendered on the server: the command filter and column show
// each command's label in the screen's language with its name under it, and a command with no label by its name.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'infiniteOptions')
          return (o: { initialPageParam: unknown; getNextPageParam: unknown }) => ({ ...o, queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

// The URL's filters (#1445), as the router hands them to the page.
const search = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useSearch: () => search.current }));

const { AuditPage } = await import('../src/routes/audit.tsx');

const row = (id: string, command: string): AuditEntry => ({
  id,
  at: '2026-10-24T03:00:00.000Z',
  actorType: 'user',
  actorId: '00000000-0000-7000-8000-0000000000a1',
  actorName: 'Lan',
  command,
  outcome: 'ok',
  targetType: null,
  targetId: null,
  proposalId: null,
  detail: null,
});

function render(locale: 'vi' | 'en'): string {
  const qc = client.current;
  qc.setQueryData(['org', 'get'], { role: 'owner', members: [] });
  qc.setQueryData(['org', 'auditCommands'], ['kernel.proposal.approve', 'kernel.retired.command', 'finance.period.lock']);
  qc.setQueryData(['org', 'audit'], { pages: [{ items: [row('a', 'kernel.proposal.approve'), row('b', 'kernel.retired.command')], more: false }], pageParams: [undefined] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <AuditPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('AuditPage command labels', () => {
  it('shows the Vietnamese label with the name under it, sorted by label in the filter', () => {
    const html = render('vi');
    expect(html).toContain('value="kernel.proposal.approve">Duyệt đề xuất</option>');
    expect(html).toContain('value="finance.period.lock">Khóa sổ kỳ kế toán</option>');
    expect(html.indexOf('Duyệt đề xuất</option>')).toBeLessThan(html.indexOf('Khóa sổ kỳ kế toán</option>'));
    expect(html).toMatch(/Duyệt đề xuất<p class="[^"]*font-mono[^"]*">kernel\.proposal\.approve<\/p>/);
  });

  it('shows the English label in English, and a command with no label by its name', () => {
    const html = render('en');
    expect(html).toContain('value="kernel.proposal.approve">Approve a proposal</option>');
    expect(html).toContain('value="kernel.retired.command">kernel.retired.command</option>');
    expect(html).toMatch(/<span class="font-mono text-xs">kernel\.retired\.command<\/span>/);
  });
});

describe('AuditPage filters from the URL (#1445)', () => {
  it('starts the target filter from a link, as a decided proposal opens it', () => {
    search.current = { targetId: '0192f0aa-1111-7222-8333-944445555666' };
    try {
      expect(render('vi')).toContain('value="0192f0aa-1111-7222-8333-944445555666"');
    } finally {
      search.current = {};
    }
  });
});
