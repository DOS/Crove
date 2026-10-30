// SPDX-License-Identifier: AGPL-3.0-only
// The restore-report role (#2007) without a database: its arguments, the reseed commands it runs for the report's
// series and the operator's floors, its summary and its exit codes. The report itself is worm.test.ts (from memory)
// and restore-report.db.test.ts (on PostgreSQL).
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@crove/db';
import type { RestoreReport } from '../src/worm.ts';

const report = vi.hoisted(() => ({ current: null as RestoreReport | null }));
vi.mock('../src/worm.ts', () => ({ restoreReport: async () => report.current }));

const { RESTORE_REPORT_EXIT, parseRestoreReportArgs, restoreReportLines, runRestoreReport } = await import('../src/restore-report.ts');

const ORG = '0190f000-0000-7000-8000-00000000000a';
const OTHER = '0190f000-0000-7000-8000-00000000000b';
const ENTITY = '0190f000-0000-7000-8000-0000000000e1';
const SERIES = '0190f000-0000-7000-8000-0000000000f1';

const clean: RestoreReport = { ok: true, batches: 3, recorded: 3, beyond: [], auditEvents: 0, orgs: [], reseed: [], uncovered: [], problems: [] };
const lostOne: RestoreReport = {
  ...clean,
  ok: false,
  recorded: 2,
  beyond: [{ seq: 3, from: '2026-10-21T00:10:00.000Z', to: '2026-10-21T00:15:00.000Z' }],
  auditEvents: 2,
  orgs: [{ orgId: ORG, journalEntries: ['e2'], cashVouchers: [], journalVouchers: ['v2'], documentVoids: [], allocations: ['a2'], numberVoids: [], series: [] }],
  reseed: [{ orgId: ORG, seriesId: SERIES, legalEntityId: ENTITY, docType: 'finance.journal_voucher', periodKey: '2026', archivedHigh: '6', next: '6' }],
};

async function run(given: RestoreReport, argv: string[]) {
  report.current = given;
  const calls: Array<{ command: string; input: unknown; orgId: string | undefined }> = [];
  const runtime = {
    execute: async (command: string, input: unknown, options: { orgId?: string }) => {
      calls.push({ command, input, orgId: options.orgId });
      return {};
    },
  };
  const lines: string[] = [];
  const out: string[] = [];
  const code = await runRestoreReport(
    { db: {} as Db, store: { put: async () => {}, get: async () => null, list: async () => [], describe: () => 'memory' }, runtime: runtime as never, log: (l) => lines.push(l), error: (l) => lines.push(l), out: (t) => out.push(t) },
    argv,
  );
  return { code, calls, lines, out };
}

describe('restore-report arguments', () => {
  it('reads --reseed, --json and floors named by org, entity, doc type and period', () => {
    expect(parseRestoreReportArgs([])).toEqual({ reseed: false, json: false, floors: [] });
    expect(parseRestoreReportArgs(['--reseed', '--json', '--floor', `${ORG}:${ENTITY}:finance.cash_voucher.pt:2026=41`])).toEqual({
      reseed: true,
      json: true,
      floors: [{ orgId: ORG, legalEntityId: ENTITY, docType: 'finance.cash_voucher.pt', periodKey: '2026', next: '41' }],
    });
    expect(parseRestoreReportArgs(['--reseed', '--floor', `${ORG}:${ENTITY}:finance.journal_voucher:-=7`]).floors[0]?.periodKey).toBe('-');
    expect(() => parseRestoreReportArgs(['--floor', `${ORG}:${ENTITY}:finance.journal_voucher:2026=7`])).toThrow('--floor takes effect with --reseed only');
    expect(() => parseRestoreReportArgs(['--reseed', '--floor', `${ORG}:${ENTITY}:finance.journal_voucher:2026=0`])).toThrow(/--floor needs/);
    expect(() => parseRestoreReportArgs(['--reseed', '--floor', `${ORG}:${ENTITY}:finance.journal_voucher:26=7`])).toThrow(/--floor needs/);
    expect(() => parseRestoreReportArgs(['--fix'])).toThrow('unknown argument --fix');
  });
});

describe('restore-report run', () => {
  it('exits 0 when the archive and the database agree', async () => {
    const { code, calls } = await run(clean, ['--reseed']);
    expect(code).toBe(RESTORE_REPORT_EXIT.ok);
    expect(calls).toEqual([]);
  });

  it('names the lost rows, and without --reseed exits 3 on a series the archive is ahead of', async () => {
    const { code, calls, lines } = await run(lostOne, []);
    expect(code).toBe(RESTORE_REPORT_EXIT.behind);
    expect(calls).toEqual([]);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('1 written after the backup point'),
        '[restore-report] lost: 2 audit event(s)',
        `[restore-report] lost in org ${ORG}: 1 journal entries: e2`,
        `[restore-report] lost in org ${ORG}: 1 journal vouchers: v2`,
        `[restore-report] lost in org ${ORG}: 1 number allocations: a2`,
        expect.stringContaining(`BEHIND: org ${ORG} series ${SERIES}`),
        expect.stringContaining('provider-issued numbers (e-invoices)'),
      ]),
    );
  });

  it('with --reseed raises each series to the archived highest + 1 and exits 2: rows were lost, no number repeats', async () => {
    const { code, calls, lines } = await run(lostOne, ['--reseed']);
    expect(code).toBe(RESTORE_REPORT_EXIT.lost);
    expect(calls).toEqual([
      {
        command: 'kernel.number.reseed',
        input: { seriesId: SERIES, legalEntityId: ENTITY, docType: 'finance.journal_voucher', periodKey: '2026', next: '7', source: 'archive', archivedHigh: '6' },
        orgId: ORG,
      },
    ]);
    expect(lines).toContain(`[restore-report] reseeded: org ${ORG} series ${SERIES} (${ENTITY} finance.journal_voucher 2026) next 7, above the archived 6 (was 6)`);
  });

  it('needs a floor for an org the version 7 batches do not cover, and applies the floors given', async () => {
    const legacy: RestoreReport = { ...lostOne, reseed: [], uncovered: [ORG, OTHER] };
    expect((await run(legacy, ['--reseed'])).code).toBe(RESTORE_REPORT_EXIT.behind);
    const floored = await run(legacy, ['--reseed', '--floor', `${ORG}:${ENTITY}:finance.journal_voucher:2026=9`]);
    expect(floored.code).toBe(RESTORE_REPORT_EXIT.behind);
    expect(floored.lines).toContain(`[restore-report] NEEDS A FLOOR: org ${OTHER} lost number allocations that no version 7 batch covers; pass --floor for each of its series from the issued vouchers`);
    const both = await run(legacy, ['--reseed', '--floor', `${ORG}:${ENTITY}:finance.journal_voucher:2026=9`, '--floor', `${OTHER}:${ENTITY}:finance.journal_voucher:2026=3`]);
    expect(both.code).toBe(RESTORE_REPORT_EXIT.lost);
    expect(both.calls.map((c) => [c.orgId, c.input])).toEqual([
      [ORG, { seriesId: null, legalEntityId: ENTITY, docType: 'finance.journal_voucher', periodKey: '2026', next: '9', source: 'floor', archivedHigh: null }],
      [OTHER, { seriesId: null, legalEntityId: ENTITY, docType: 'finance.journal_voucher', periodKey: '2026', next: '3', source: 'floor', archivedHigh: null }],
    ]);
  });

  it('raises nothing, from the archive or a floor, when the archive does not match, and exits 1', async () => {
    const untrusted: RestoreReport = { ...lostOne, uncovered: [OTHER], problems: [{ code: 'record_mismatch', seq: 3 }] };
    const { code, calls } = await run(untrusted, ['--reseed', '--floor', `${OTHER}:${ENTITY}:finance.journal_voucher:2026=3`]);
    expect(code).toBe(RESTORE_REPORT_EXIT.failed);
    expect(calls).toEqual([]);
  });

  it('exits 1 when the archive does not match, and prints the whole report as JSON with --json', async () => {
    const broken: RestoreReport = { ...clean, ok: false, problems: [{ code: 'object_missing', seq: 4 }] };
    const { code, lines, out } = await run(broken, ['--json']);
    expect(code).toBe(RESTORE_REPORT_EXIT.failed);
    expect(lines).toContain('[restore-report] PROBLEM: object_missing in batch 4');
    expect(JSON.parse(out.join(''))).toMatchObject({ problems: [{ code: 'object_missing', seq: 4 }], reseeded: [], behind: [], needFloor: [] });
  });

  it('lists at most 20 ids per kind in the summary', () => {
    const many = Array.from({ length: 25 }, (_, i) => `e${i}`);
    const lines = restoreReportLines({ report: { ...lostOne, orgs: [{ ...lostOne.orgs[0]!, journalEntries: many }] }, reseeded: [], behind: [], needFloor: [] });
    expect(lines).toContain(`lost in org ${ORG}: 25 journal entries: ${many.slice(0, 20).join(' ')} and 5 more`);
  });
});
