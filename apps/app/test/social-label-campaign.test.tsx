// Campaign labels (#1169) in the app: the Labels page offers a campaign's dates and UTM tags to owners and admins only
// and shows them on each label, the post screen says where a channel does not follow its campaign label, the calendar
// knows which days fall outside the campaign, and the client report form takes the label's dates. Rendered on the
// server from a seeded cache, in Vietnamese and English.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';
import { daysOutsideCampaign } from '../src/lib/social-calendar.ts';
import { campaignInput, campaignProblem, labelPeriod } from '../src/lib/social-labels.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ slug: 'hoa-mai' }), Link: () => null }));

const { CampaignFindings } = await import('../src/components/social-labels.tsx');
const { SocialLabelsPage } = await import('../src/routes/social-labels.tsx');

const TET = '00000000-0000-4000-8000-0000000000a1';
const PLAIN = '00000000-0000-4000-8000-0000000000a2';
const BY = '00000000-0000-4000-8000-000000000009';
const tet = { id: TET, name: 'Tết', color: 'red' as const, createdBy: BY, postCount: 3, startsOn: '2027-01-20', endsOn: '2027-02-15', utmCampaign: 'tet-2027', utmMedium: null };
const plain = { id: PLAIN, name: 'Khách A', color: 'gray' as const, createdBy: BY, postCount: 1, startsOn: null, endsOn: null, utmCampaign: null, utmMedium: null };

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const render = (node: React.ReactNode, locale: 'vi' | 'en') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
};

const channels = [
  // Another case of the label's campaign, inside the dates.
  { name: 'Trang A', settings: { utm: { campaign: 'Tet-2027' } }, linkUrl: 'https://shop.example/', at: '2027-02-01T05:00:00.000Z' },
  // No tags on the link, and a day after the campaign in Hồ Chí Minh City.
  { name: 'Trang B', settings: {}, linkUrl: 'https://shop.example/', at: '2027-02-15T20:00:00.000Z' },
];

describe('campaign labels in the app (#1169)', () => {
  beforeEach(() => client.current.clear());

  it("names each channel that misses its campaign label's UTM campaign or dates", () => {
    const findings = (locale: 'vi' | 'en') => text(render(<CampaignFindings labelIds={[PLAIN, TET]} labels={[tet, plain]} channels={channels} timeZone="Asia/Ho_Chi_Minh" />, locale));
    expect(findings('vi')).toBe(
      'Chưa khớp với chiến dịch ' +
        'Trang A: UTM campaign "Tet-2027" khác với "tet-2027" của nhãn "Tết", số liệu chiến dịch sẽ bị tách làm hai. ' +
        'Trang B: liên kết chưa gắn UTM campaign "tet-2027" của nhãn "Tết". ' +
        'Trang B: hẹn đăng ngày 16/02/2027, ngoài thời gian chiến dịch "Tết" (từ 20/01/2027 đến 15/02/2027).',
    );
    const en = findings('en');
    expect(en).toContain('Trang A: UTM campaign "Tet-2027" differs from "tet-2027" of the label "Tết"');
    expect(en).toContain('Trang B: the link has no UTM campaign "tet-2027" of the label "Tết".');
    expect(en).toMatch(/Trang B: planned for .+, outside the "Tết" campaign \(.+ to .+\)\.$/);
  });

  it('says nothing for plain labels or a post without labels, as before', () => {
    expect(render(<CampaignFindings labelIds={[PLAIN]} labels={[tet, plain]} channels={channels} timeZone="Asia/Ho_Chi_Minh" />, 'vi')).toBe('');
    expect(render(<CampaignFindings labelIds={[]} labels={[tet, plain]} channels={channels} timeZone="Asia/Ho_Chi_Minh" />, 'vi')).toBe('');
  });

  for (const locale of ['vi', 'en'] as const) {
    const t = catalog(locale).social.labels;
    const page = (role: string) => {
      client.current.setQueryData(['me', 'get'], { orgs: [{ slug: 'hoa-mai', role }] });
      client.current.setQueryData(['social', 'labels', 'list'], [tet, plain]);
      return render(<SocialLabelsPage />, locale);
    };

    it(`offers a campaign's dates and UTM tags to owners and admins, and shows them on the label (${locale})`, () => {
      const owner = page('owner');
      expect(owner).toContain('id="label-new-utm-campaign"');
      expect(owner).toContain('id="label-new-from"');
      expect(owner).toContain(`>${t.campaign}</legend>`);
      const shown = text(owner);
      expect(shown).toContain(locale === 'vi' ? 'Chiến dịch: từ 20/01/2027 đến 15/02/2027 · UTM tet-2027 / social' : 'Campaign: ');
      expect(shown).toContain('UTM tet-2027 / social');
      // A plain label shows no campaign line.
      expect(shown.split(t.campaignLine.replace('{details}', '')).length - 1).toBe(1);
      // A member adds plain labels only.
      const member = page('member');
      expect(member).toContain('id="label-new-name"');
      expect(member).not.toContain('id="label-new-utm-campaign"');
      expect(member).not.toContain(`>${t.campaign}</legend>`);
    });
  }

  it("checks the campaign as the server would, and sends empty fields as cleared", () => {
    const empty = { startsOn: '', endsOn: '', utmCampaign: '', utmMedium: '' };
    expect(campaignProblem(empty)).toBeNull();
    expect(campaignProblem({ ...empty, startsOn: '2027-02-01', endsOn: '2027-01-31' })).toBe('dates');
    expect(campaignProblem({ ...empty, startsOn: '2027-02-01', endsOn: '2027-02-01' })).toBeNull();
    expect(campaignProblem({ ...empty, utmCampaign: 'a*b' })).toBe('utm');
    expect(campaignProblem({ ...empty, utmCampaign: 'ok', utmMedium: '😀' })).toBe('utm');
    expect(campaignProblem({ ...empty, utmMedium: 'email' })).toBe('mediumNeedsCampaign');
    expect(campaignInput({ startsOn: '2027-01-20', endsOn: '', utmCampaign: ' tet ', utmMedium: '  ' })).toEqual({ startsOn: '2027-01-20', endsOn: null, utmCampaign: 'tet', utmMedium: null });
  });

  it("starts a label's client report on its campaign's dates", () => {
    const shown = { from: '2026-09-01', to: '2026-09-30' };
    expect(labelPeriod(tet, shown)).toEqual({ from: '2027-01-20', to: '2027-02-15' });
    expect(labelPeriod(plain, shown)).toEqual(shown);
    // One open end keeps the period shown on that side, never ending before it starts.
    expect(labelPeriod({ startsOn: '2026-09-10', endsOn: null }, shown)).toEqual({ from: '2026-09-10', to: '2026-09-30' });
    expect(labelPeriod({ startsOn: '2026-12-01', endsOn: null }, shown)).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    expect(labelPeriod({ startsOn: null, endsOn: '2026-08-15' }, shown)).toEqual({ from: '2026-08-15', to: '2026-08-15' });
  });

  it('shades the calendar days outside the campaign, and none for a plain label', () => {
    const days = Array.from({ length: 5 }, (_, i) => new Date(2027, 1, 13 + i));
    expect([...daysOutsideCampaign(tet, days)]).toEqual(['2027-02-16', '2027-02-17']);
    expect([...daysOutsideCampaign({ startsOn: '2027-02-15', endsOn: null }, days)]).toEqual(['2027-02-13', '2027-02-14']);
    expect(daysOutsideCampaign(plain, days).size).toBe(0);
    expect(daysOutsideCampaign(undefined, days).size).toBe(0);
  });
});
