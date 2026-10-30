// SPDX-License-Identifier: AGPL-3.0-only
// The restore-report role (#2007) without a database: its arguments, the reseed commands it runs for the report's
// series and the operator's floors, its summary and its exit codes. The report itself is worm.test.ts (from memory)
// and restore-report.db.test.ts (on PostgreSQL).
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@crove/db';
import { DomainError } from '@crove/kernel-runtime';
import type { RestoreReport } from '../src/worm.ts';

const report = vi.hoisted(() => ({ current: null as RestoreReport | null, acknowledged: [] as RestoreReport[] }));
vi.mock('../src/worm.ts', () => ({
  restoreReport: async () => report.current,
  acknowledgeRestore: async (_db: unknown, _store: unknown, r: RestoreReport) => {
    report.acknowledged.push(r);
    return 'restores/v1/000000000002-000000000003.json';
  },
}));

const { RESTORE_REPORT_EXIT, parseRestoreReportArgs, restoreReportLines, runRestoreReport } = await import('../src/restore-report.ts');

const ORG = '0190f000-0000-7000-8000-00000000000a';
const OTHER = '0190f000-0000-7000-8000-00000000000b';
const ENTITY = '0190f000-0000-7000-8000-0000000000e1';
const SERIES = '0190f000-0000-7000-8000-0000000000f1';

const clean: RestoreReport = {
  ok: true,
  batches: 3,
  recorded: 3,
  beyond: [],
  auditEvents: 0,
  orgs: [],
  reseed: [],
  uncovered: [],
  uncoveredSeries: [],
  orphaned: [],
  lostRefs: [],
  acknowledgedRefs: [],
  acknowledgedIntervals: [],
  latestAck: null,
  problems: [],
};
const lostOne: RestoreReport = {
  ...clean,
  ok: false,
  recorded: 2,
  beyond: [{ seq: 3, from: '2026-10-21T00:10:00.000Z', to: '2026-10-21T00:15:00.000Z' }],
  auditEvents: 2,
  orgs: [{ orgId: ORG, journalEntries: ['e2'], cashVouchers: [], journalVouchers: ['v2'], documentVoids: [], allocations: ['a2'], numberVoids: [], series: [] }],
  reseed: [{ orgId: ORG, seriesId: SERIES, legalEntityId: ENTITY, docType: 'finance.journal_voucher', periodKey: '2026', archivedHigh: '6', next: '6' }],
};

async function run(given: RestoreReport, argv: string[], refuse: (input: unknown) => Error | null = () => null) {
  report.current = given;
  report.acknowledged = [];
  const calls: Array<{ command: string; input: unknown; orgId: string | undefined }> = [];
  const runtime = {
    execute: async (command: string, input: unknown, options: { orgId?: string }) => {
      calls.push({ command, input, orgId: options.orgId });
      const refusal = refuse(input);
      if (refusal) throw refusal;
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
  it('reads --reseed, --json, floors named by org, entity, doc type and period, and the orgs whose floors are complete', () => {
    expect(parseRestoreReportArgs([])).toEqual({ reseed: false, json: false, floors: [], floorsComplete: [], acknowledge: false, backupPoint: null });
    expect(parseRestoreReportArgs(['--acknowledge', '--backup-point', '2026-10-30T02:00:00Z']).backupPoint).toBe('2026-10-30T02:00:00.000Z');
    expect(() => parseRestoreReportArgs(['--backup-point', 'yesterday'])).toThrow(/--backup-point needs a UTC time/);
    expect(
      parseRestoreReportArgs(['--reseed', '--json', '--floor', `${ORG}:${ENTITY}:finance.cash_voucher.pt:2026=41`, '--floors-complete', ORG, '--acknowledge']),
    ).toEqual({
      reseed: true,
      json: true,
      floors: [{ orgId: ORG, legalEntityId: ENTITY, docType: 'finance.cash_voucher.pt', periodKey: '2026', next: '41' }],
      floorsComplete: [ORG],
      acknowledge: true,
      backupPoint: null,
    });
    expect(() => parseRestoreReportArgs(['--floors-complete', ORG])).toThrow('take effect with --reseed only');
    expect(() => parseRestoreReportArgs(['--reseed', '--floors-complete', 'acme'])).toThrow('--floors-complete needs an org id');
    expect(parseRestoreReportArgs(['--reseed', '--floor', `${ORG}:${ENTITY}:finance.journal_voucher:-=7`]).floors[0]?.periodKey).toBe('-');
    expect(() => parseRestoreReportArgs(['--floor', `${ORG}:${ENTITY}:finance.journal_voucher:2026=7`])).toThrow('take effect with --reseed only');
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

  it('acknowledges the restore with --acknowledge once every series is safe, and not before (#2020)', async () => {
    const safe = await run(lostOne, ['--reseed', '--acknowledge']);
    expect(safe.code).toBe(RESTORE_REPORT_EXIT.lost);
    expect(report.acknowledged).toEqual([lostOne]);
    expect(safe.lines).toEqual(expect.arrayContaining([expect.stringContaining('acknowledged: ')]));
    // Without --reseed the series stay behind: no acknowledgement, so the verifier keeps failing.
    const behind = await run(lostOne, ['--acknowledge']);
    expect(behind.code).toBe(RESTORE_REPORT_EXIT.behind);
    expect(report.acknowledged).toEqual([]);
    // Nor for an archive with a problem.
    expect((await run({ ...lostOne, problems: [{ code: 'record_mismatch', seq: 3 }] }, ['--reseed', '--acknowledge'])).code).toBe(RESTORE_REPORT_EXIT.failed);
    expect(report.acknowledged).toEqual([]);
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

  it('keeps raising the other series when the reseed refuses one, and exits 3 with the reason', async () => {
    const two: RestoreReport = { ...lostOne, reseed: [...lostOne.reseed, { ...lostOne.reseed[0]!, seriesId: OTHER, periodKey: '2026-10' }] };
    const { code, calls, lines } = await run(two, ['--reseed'], (input) =>
      (input as { periodKey: string }).periodKey === '2026-10' ? new DomainError('NUMBER_RESEED_PERIOD_MISFIT', 422, 'Kỳ đánh số không khớp') : null,
    );
    expect(code).toBe(RESTORE_REPORT_EXIT.behind);
    expect(calls).toHaveLength(2);
    expect(lines).toContain(`[restore-report] reseeded: org ${ORG} series ${SERIES} (${ENTITY} finance.journal_voucher 2026) next 7, above the archived 6 (was 6)`);
    expect(lines.some((l) => l.includes(`BEHIND: org ${ORG} series ${OTHER}`) && l.includes('NUMBER_RESEED_PERIOD_MISFIT'))).toBe(true);
  });

  it('names a series lost with its org or legal entity, and raises nothing for it', async () => {
    const orphan: RestoreReport = { ...lostOne, reseed: [], orphaned: lostOne.reseed };
    const { code, calls, lines } = await run(orphan, ['--reseed']);
    expect(code).toBe(RESTORE_REPORT_EXIT.lost);
    expect(calls).toEqual([]);
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining(`lost with its org or legal entity: org ${ORG} series ${SERIES}`)]));
  });

  it('needs a floor for every series of an org the version 7 batches do not cover, and the operator\'s word that none is missing', async () => {
    const series = (docType: string) => ({ orgId: ORG, seriesId: SERIES, legalEntityId: ENTITY, docType, periodKey: '2026', next: '4' });
    const legacy: RestoreReport = { ...lostOne, reseed: [], uncovered: [ORG], uncoveredSeries: [series('finance.journal_voucher'), series('finance.cash_voucher.pt')] };
    const floor = (docType: string, next: string) => ['--floor', `${ORG}:${ENTITY}:${docType}:2026=${next}`];
    expect((await run(legacy, ['--reseed'])).code).toBe(RESTORE_REPORT_EXIT.behind);
    // Two series, one floored: the other could give out an archived number again, so the run refuses.
    const one = await run(legacy, ['--reseed', ...floor('finance.journal_voucher', '9'), '--floors-complete', ORG]);
    expect(one.code).toBe(RESTORE_REPORT_EXIT.behind);
    expect(one.lines).toEqual(expect.arrayContaining([expect.stringContaining(`NEEDS A FLOOR: org ${ORG} series ${ENTITY} finance.cash_voucher.pt 2026 (restored next 4)`)]));
    // Every series floored, but no word that no series made after the backup point is missing.
    const unconfirmed = await run(legacy, ['--reseed', ...floor('finance.journal_voucher', '9'), ...floor('finance.cash_voucher.pt', '41')]);
    expect(unconfirmed.code).toBe(RESTORE_REPORT_EXIT.behind);
    expect(unconfirmed.lines).toEqual(expect.arrayContaining([expect.stringContaining(`pass --floors-complete ${ORG}`)]));
    const done = await run(legacy, ['--reseed', ...floor('finance.journal_voucher', '9'), ...floor('finance.cash_voucher.pt', '41'), '--floors-complete', ORG]);
    expect(done.code).toBe(RESTORE_REPORT_EXIT.lost);
    expect(done.calls.map((c) => [c.orgId, c.input])).toEqual([
      [ORG, { seriesId: null, legalEntityId: ENTITY, docType: 'finance.journal_voucher', periodKey: '2026', next: '9', source: 'floor', archivedHigh: null }],
      [ORG, { seriesId: null, legalEntityId: ENTITY, docType: 'finance.cash_voucher.pt', periodKey: '2026', next: '41', source: 'floor', archivedHigh: null }],
    ]);
    // A floor the reseed refuses does not count.
    const refused = await run(legacy, ['--reseed', ...floor('finance.journal_voucher', '9'), ...floor('finance.cash_voucher.pt', '41'), '--floors-complete', ORG], (input) =>
      (input as { docType: string }).docType === 'finance.cash_voucher.pt' ? new DomainError('NUMBER_RESEED_PERIOD_MISFIT', 422, 'Kỳ đánh số không khớp') : null,
    );
    expect(refused.code).toBe(RESTORE_REPORT_EXIT.behind);
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
    expect(JSON.parse(out.join(''))).toMatchObject({ problems: [{ code: 'object_missing', seq: 4 }], reseeded: [], behind: [], failedFloors: [], needFloor: [], missingFloors: [] });
  });

  it('lists at most 20 ids per kind in the summary', () => {
    const many = Array.from({ length: 25 }, (_, i) => `e${i}`);
    const lines = restoreReportLines({
      report: { ...lostOne, orgs: [{ ...lostOne.orgs[0]!, journalEntries: many }] },
      reseeded: [],
      behind: [],
      failedFloors: [],
      needFloor: [],
      missingFloors: [],
      unconfirmed: [],
      acknowledged: null,
    });
    expect(lines).toContain(`lost in org ${ORG}: 25 journal entries: ${many.slice(0, 20).join(' ')} and 5 more`);
  });
});
