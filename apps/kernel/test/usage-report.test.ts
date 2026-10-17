// Weekly usage report (issue #311), unit part: arguments, output formats and exit codes. The database part is in
// usage-report.db.test.ts and test/invariant/usage-report.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_USAGE_ARGS, USAGE_EXIT, formatUsage, parseUsageArgs, runUsageReport, type UsageRow } from '../src/usage-report.ts';

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
    expect(DEFAULT_USAGE_ARGS).toEqual({ weeks: 8, byOrg: false, csv: false, timeZone: 'Asia/Ho_Chi_Minh' });
    expect(parseUsageArgs(['--', '--weeks', '4', '--by-org', '--csv', '--time-zone', 'UTC'])).toEqual({ weeks: 4, byOrg: true, csv: true, timeZone: 'UTC' });
  });

  it('refuses bad values and unknown arguments', () => {
    for (const argv of [['--weeks', '0'], ['--weeks', '105'], ['--weeks', '2.5'], ['--weeks', '0x10'], ['--weeks', '1e1'], ['--weeks'], ['--time-zone', "UTC'; --"], ['--time-zone'], ['--org']]) {
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
