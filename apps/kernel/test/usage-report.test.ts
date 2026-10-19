// Weekly usage report (issue #311), unit part: arguments, output formats and exit codes, and the weekly summary that
// --post sends to the alert webhook (issue #344). The database part is in usage-report.db.test.ts and
// test/invariant/usage-report.db.test.ts.
import { describe, expect, it } from 'vitest';
import { messageBody } from '../src/alert.ts';
import { DEFAULT_USAGE_ARGS, USAGE_EXIT, formatUsage, parseUsageArgs, runUsageReport, usageSummary, type UsageRow } from '../src/usage-report.ts';

const total: UsageRow = {
  week_start: '2026-10-12',
  iso_week: '2026-W42',
  org_id: null,
  org_name: null,
  active_orgs: 2,
  active_users: 3,
  documents_uploaded: 10,
  documents_emailed: 4,
  proposals_approved: 8,
  approved_without_edits: 6,
  proposals_rejected: 1,
  median_upload_to_approval_seconds: 5400,
  journal_exports: 2,
  org_exports: 0,
};
const org: UsageRow = { ...total, org_id: '0190a1b2-0000-7000-8000-000000000001', org_name: '=HYPERLINK("x"), "Co"', active_orgs: 1, proposals_approved: 0, approved_without_edits: 0, median_upload_to_approval_seconds: null };

describe('usage report arguments', () => {
  it('defaults to 8 weeks of deployment totals as a table in Asia/Ho_Chi_Minh', () => {
    expect(parseUsageArgs([])).toEqual(DEFAULT_USAGE_ARGS);
    expect(DEFAULT_USAGE_ARGS).toEqual({ weeks: 8, byOrg: false, csv: false, timeZone: 'Asia/Ho_Chi_Minh', post: false });
    expect(parseUsageArgs(['--', '--weeks', '4', '--by-org', '--csv', '--time-zone', 'UTC'])).toEqual({ weeks: 4, byOrg: true, csv: true, timeZone: 'UTC', post: false });
    expect(parseUsageArgs(['--post', '--weeks', '3'])).toMatchObject({ weeks: 3, post: true });
  });

  it('refuses bad values and unknown arguments', () => {
    for (const argv of [['--weeks', '0'], ['--weeks', '105'], ['--weeks', '2.5'], ['--weeks', '0x10'], ['--weeks', '1e1'], ['--weeks'], ['--time-zone', "UTC'; --"], ['--time-zone'], ['--org'], ['--post', '--weeks', '2'], ['--weeks', '1', '--post']]) {
      expect(() => parseUsageArgs(argv), argv.join(' ')).toThrow();
    }
  });
});

describe('usage report output', () => {
  it('prints an aligned table, with org columns only for --by-org', () => {
    const table = formatUsage([total], { byOrg: false, csv: false }).split('\n');
    expect(table[0]).toMatch(/^week\s+from\s+active_orgs\s+active_users\s+uploaded/);
    expect(table[1]).toMatch(/^2026-W42\s+2026-10-12\s+2\s+3\s+10\s+4\s+8\s+6\s+75\s+1\s+1\.5\s+2\s+0$/);
    expect(formatUsage([total], { byOrg: true, csv: false })).toMatch(/org_id\s+org\s+/);
  });

  it('writes CSV with quoting and an inert org name', () => {
    const csv = formatUsage([total, org], { byOrg: true, csv: true }).split('\n');
    expect(csv[1]).toBe('2026-W42,2026-10-12,ALL,ALL,2,3,10,4,8,6,75,1,1.5,2,0');
    // A name starting with = would be a formula in a spreadsheet: it is prefixed, and quoted for the comma and quotes.
    expect(csv[2]).toBe(`2026-W42,2026-10-12,${org.org_id},"'=HYPERLINK(""x""), ""Co""",1,3,10,4,0,0,,1,,2,0`);
  });

  it('keeps control characters of an org name out of the table', () => {
    const text = formatUsage([{ ...org, org_name: 'A\nB\u001b[31m' }], { byOrg: true, csv: false });
    expect(text.split('\n')).toHaveLength(2);
    expect(text).not.toContain('\u001b');
  });
});

describe('usage report exit codes', () => {
  const quiet = () => {
    const err: string[] = [];
    return { err, deps: { log: () => {}, error: (l: string) => err.push(l) } };
  };

  it('fails with 2 without REPORTER_DATABASE_URL or with a bad argument, and never reads then', async () => {
    let reads = 0;
    const readUsage = async () => {
      reads++;
      return [];
    };
    const a = quiet();
    expect(await runUsageReport([], {}, { ...a.deps, readUsage })).toBe(USAGE_EXIT.failed);
    expect(a.err.join('\n')).toContain('REPORTER_DATABASE_URL is not set');
    const b = quiet();
    expect(await runUsageReport(['--weeks', 'x'], { REPORTER_DATABASE_URL: 'postgres://r@db/p' }, { ...b.deps, readUsage })).toBe(USAGE_EXIT.failed);
    expect(reads).toBe(0);
  });

  it('reports a failed read on one line with exit 2, and prints the rows with exit 0', async () => {
    const a = quiet();
    const failing = async () => {
      throw new Error('permission denied\nfor function usage_weekly');
    };
    expect(await runUsageReport([], { REPORTER_DATABASE_URL: 'postgres://r@db/p' }, { ...a.deps, readUsage: failing })).toBe(USAGE_EXIT.failed);
    expect(a.err).toEqual(['[usage-report] could not read crove_kernel.usage_weekly(): permission denied for function usage_weekly']);
    const out: string[] = [];
    expect(await runUsageReport(['--csv'], { REPORTER_DATABASE_URL: 'postgres://r@db/p' }, { log: (t) => out.push(t), error: () => {}, readUsage: async () => [total] })).toBe(USAGE_EXIT.ok);
    expect(out[0]?.split('\n')[1]).toBe('2026-W42,2026-10-12,2,3,10,4,8,6,75,1,1.5,2,0');
  });
});

describe('usage report --post (#344)', () => {
  // Three weeks, oldest first: the week before last, last week (the summary's week) and the current one. The org rows
  // must never reach the webhook.
  const week = (iso_week: string, week_start: string, over: Partial<UsageRow> = {}): UsageRow => ({ ...total, iso_week, week_start, ...over });
  const rows: UsageRow[] = [
    week('2026-W41', '2026-10-05', { active_orgs: 1, active_users: 2, proposals_approved: 5, approved_without_edits: 3, median_upload_to_approval_seconds: null }),
    { ...org, iso_week: '2026-W41', week_start: '2026-10-05' },
    week('2026-W42', '2026-10-12'),
    { ...org, iso_week: '2026-W42', week_start: '2026-10-12' },
    week('2026-W43', '2026-10-19', { active_users: 99 }),
  ];
  const SECRET = 'usage-secret-344';
  const SLACK = `https://hooks.slack.com/services/T000/B000/${SECRET}`;
  const AT = new Date('2026-10-19T01:00:00.000Z');
  const env = (over: Record<string, string> = {}) => ({ REPORTER_DATABASE_URL: 'postgres://r@db/p', ALERT_INSTANCE: 'books.example.test', ...over });

  interface Sent {
    url: string;
    body: Record<string, unknown>;
  }
  const harness = (respond: () => Response | Promise<Response> = () => new Response('ok', { status: 200 })) => {
    const out: string[] = [];
    const err: string[] = [];
    const sent: Sent[] = [];
    let reads = 0;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return respond();
    }) as typeof globalThis.fetch;
    const readUsage = async () => {
      reads++;
      return rows;
    };
    return { out, err, sent, reads: () => reads, deps: { log: (t: string) => out.push(t), error: (l: string) => err.push(l), readUsage, fetch, now: () => AT } };
  };

  it('summarizes the last complete week against the week before, deployment totals only', () => {
    const summary = usageSummary(rows, 'Asia/Ho_Chi_Minh', 'books.example.test', AT);
    expect(summary?.text.split('\n')).toEqual([
      '[Crove] Weekly usage on books.example.test: 2026-W42, from 2026-10-12 (Asia/Ho_Chi_Minh). In brackets: 2026-W41.',
      '- active orgs: 2 [1]',
      '- active users: 3 [2]',
      '- documents uploaded: 10 [10]',
      '- documents emailed: 4 [4]',
      '- proposals approved: 8 [5]',
      '- approved without edits: 6, 75% [3, 60%]',
      '- proposals rejected: 1 [1]',
      '- median upload to approval: 1.5 h [none]',
      '- journal exports: 2 [2]',
      '- org exports: 0 [0]',
    ]);
    // A generic receiver gets the counts as data, without the org columns.
    const body = messageBody(summary!, 'generic');
    expect(body).toMatchObject({ text: summary!.text, content: summary!.text, crove: { kind: 'usage', severity: 'info', instance: 'books.example.test', at: AT.toISOString(), time_zone: 'Asia/Ho_Chi_Minh' } });
    const crove = body.crove as { week: Record<string, unknown>; previous: Record<string, unknown> };
    expect(crove.week).toMatchObject({ iso_week: '2026-W42', active_users: 3 });
    expect(crove.previous).toMatchObject({ iso_week: '2026-W41', active_users: 2 });
    expect(Object.keys(crove.week)).not.toContain('org_id');
    expect(JSON.stringify(body)).not.toContain('HYPERLINK');
    expect(usageSummary(rows.slice(2), 'UTC', 'x', AT)).toBeNull();
  });

  it('fails closed with exit 2 before reading when ALERT_WEBHOOK_URL is unset or invalid, and never prints the URL', async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{}, /--post needs ALERT_WEBHOOK_URL/],
      [{ ALERT_WEBHOOK_URL: '   ' }, /--post needs ALERT_WEBHOOK_URL/],
      [{ ALERT_WEBHOOK_URL: `ftp://alerts.example.test/${SECRET}` }, /invalid usage-report configuration: ALERT_WEBHOOK_URL/],
      [{ ALERT_WEBHOOK_URL: `https://api.telegram.org/bot${SECRET}/sendMessage` }, /ALERT_TELEGRAM_CHAT_ID/],
      [{ ALERT_WEBHOOK_URL: SLACK, ALERT_WEBHOOK_FORMAT: 'teams' }, /ALERT_WEBHOOK_FORMAT/],
    ];
    for (const [over, message] of cases) {
      const h = harness();
      expect(await runUsageReport(['--post'], env(over), h.deps), JSON.stringify(over)).toBe(USAGE_EXIT.failed);
      expect(h.err.join('\n')).toMatch(message);
      expect(h.err.join('\n')).toContain('nothing was read or posted');
      expect(h.err.join('\n')).not.toContain(SECRET);
      expect(h.reads()).toBe(0);
      expect(h.sent).toEqual([]);
      expect(h.out).toEqual([]);
    }
    // Without --post the webhook settings are not read at all.
    const h = harness();
    expect(await runUsageReport([], env({ ALERT_WEBHOOK_FORMAT: 'teams' }), h.deps)).toBe(USAGE_EXIT.ok);
    expect(h.sent).toEqual([]);
  });

  it('prints the report, posts the summary in the webhook format and confirms on stderr by host only', async () => {
    const h = harness();
    expect(await runUsageReport(['--post', '--by-org', '--csv'], env({ ALERT_WEBHOOK_URL: SLACK }), h.deps)).toBe(USAGE_EXIT.ok);
    // stdout is the report alone, org rows included, so `--csv > usage.csv` stays a clean file.
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain('HYPERLINK');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.url).toBe(SLACK);
    expect(h.sent[0]?.body).toEqual({ text: usageSummary(rows, 'Asia/Ho_Chi_Minh', 'books.example.test', AT)?.text, mrkdwn: false });
    expect(JSON.stringify(h.sent[0]?.body)).not.toContain('HYPERLINK');
    expect(h.err).toEqual(['[usage-report] summary posted to slack webhook at hooks.slack.com']);

    const t = harness(() => Response.json({ ok: true }));
    const bot = `https://api.telegram.org/bot${SECRET}/sendMessage`;
    expect(await runUsageReport(['--post'], env({ ALERT_WEBHOOK_URL: bot, ALERT_TELEGRAM_CHAT_ID: '-1001234567890' }), t.deps)).toBe(USAGE_EXIT.ok);
    expect(t.sent[0]?.body).toMatchObject({ chat_id: '-1001234567890', link_preview_options: { is_disabled: true } });
    expect(t.err.join('\n')).not.toContain(SECRET);
  });

  it('exits 3 when the post fails, with the vendor reason and the host, never the URL', async () => {
    const refused = harness(() => new Response('invalid_payload', { status: 400 }));
    expect(await runUsageReport(['--post'], env({ ALERT_WEBHOOK_URL: SLACK }), refused.deps)).toBe(USAGE_EXIT.postFailed);
    expect(refused.out).toHaveLength(1);
    expect(refused.err).toEqual(['[usage-report] could not post the summary: slack webhook at hooks.slack.com failed: HTTP 400: invalid_payload']);

    // A transport error that quotes the URL is scrubbed.
    const broken = harness(() => {
      throw new TypeError(`request to ${SLACK} failed`);
    });
    expect(await runUsageReport(['--post'], env({ ALERT_WEBHOOK_URL: SLACK }), broken.deps)).toBe(USAGE_EXIT.postFailed);
    expect(broken.err.join('\n')).toContain('request to <webhook> failed');
    expect(broken.err.join('\n')).not.toContain(SECRET);

    // A report that came back short (an older function, say) is not posted.
    const short = harness();
    expect(await runUsageReport(['--post'], env({ ALERT_WEBHOOK_URL: SLACK }), { ...short.deps, readUsage: async () => rows.slice(2) })).toBe(USAGE_EXIT.postFailed);
    expect(short.sent).toEqual([]);
  });
});