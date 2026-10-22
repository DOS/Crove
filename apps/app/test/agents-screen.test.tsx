// The agents screen as each role sees it (ADR-0029 section 9, issue #339): an agent-held position carries the AI
// label, and every control is shown only to the roles that may use it. Rendered on the server (no DOM needed), with
// the queries answered from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';

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
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    takeOrgLeftNotice: () => null,
  };
});
vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['kernel', 'accounting'] }),
  auth: {},
  authErrorText: () => '',
  authFailure: () => ({}),
}));

const { AgentsPage } = await import('../src/routes/agents.tsx');

const member = { userId: 'u1', email: 'an@example.com', displayName: 'An' };
const chart = {
  root: [{ userId: 'u1', email: 'an@example.com', displayName: 'An' }],
  positions: [
    { id: 'p1', title: 'Chief accountant', module: 'accounting', roleKey: 'accountant', reportsTo: null, status: 'active', jobDescription: null, holder: { type: 'agent', agentId: 'a1', name: 'Kế toán AI', ai: true } },
    { id: 'p2', title: 'Clerk', module: 'accounting', roleKey: 'clerk', reportsTo: 'p1', status: 'active', jobDescription: null, holder: { type: 'user', userId: 'u1', email: 'an@example.com', displayName: 'An', ai: false } },
  ],
  agents: [{ id: 'a1', templateKey: 'accountant', displayName: 'Kế toán AI', status: 'active', maxRisk: 'R1', dailyRunCap: 50 }],
  killSwitches: [],
};
const templates = [{ key: 'accountant', module: 'accounting', title: 'Accountant', roleKey: 'accountant', maxRisk: 'R1', dailyRunCap: 50, jobDescription: null, moduleEnabled: true }];

function page(role: string | null): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['org', 'get'], { role, members: [member] });
  qc.setQueryData(['chart', 'get'], chart);
  qc.setQueryData(['chart', 'templates'], templates);
  qc.setQueryData(['agents', 'budgets'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <AgentsPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const positionCards = (html: string) => html.split('data-testid="position"').slice(1);

describe('AgentsPage', () => {
  beforeEach(() => client.current.clear());

  it('labels the agent-held position as AI and not the member-held one', () => {
    const [agentHeld, memberHeld] = positionCards(page('owner'));
    expect(agentHeld).toContain('Chief accountant');
    expect(agentHeld).toContain(`aria-label="${en.agents.aiBadge}"`);
    expect(memberHeld).toContain('Clerk');
    expect(memberHeld).not.toContain(`aria-label="${en.agents.aiBadge}"`);
  });

  it('gives owners every control', () => {
    const html = page('owner');
    for (const shown of [en.agents.stop, en.agents.addPosition, en.agents.holder, en.agents.save, en.agents.install, en.agents.setBudget]) expect(html).toContain(`>${shown}<`);
  });

  it('gives admins Stop AI and the budgets to read, nothing that changes the chart', () => {
    const html = page('admin');
    expect(html).toContain(`>${en.agents.stop}<`);
    expect(html).toContain(`>${en.agents.budgetsTitle}<`);
    for (const hidden of [en.agents.addPosition, en.agents.holder, en.agents.save, en.agents.install, en.agents.setBudget]) expect(html).not.toContain(`>${hidden}<`);
  });

  it.each(['member', 'viewer', null])('shows a %s the chart and the AI labels only', (role) => {
    const html = page(role);
    expect(html).toContain(en.agents.aiBadge);
    for (const hidden of [en.agents.stop, en.agents.addPosition, en.agents.holder, en.agents.save, en.agents.install, en.agents.setBudget, en.agents.budgetsTitle]) {
      expect(html).not.toContain(`>${hidden}<`);
    }
  });
});
