// SPDX-License-Identifier: AGPL-3.0-only
// The `restore-report` image role (issue #2007, plan §7.9): after a restore, what the WORM archive holds that the
// restored database lacks, and the number series raised above the numbers the archive holds. tools/backup/restore.sh
// runs it in the worker's container before the stack starts, and an operator may run it again at any time (the worker
// login is the only role that may read the archive hashes and run the reseed):
//
//   restore-report [--reseed] [--floor <org id>:<legal entity id>:<doc type>:<period key>=<next number>]...
//                  [--floors-complete <org id>]... [--acknowledge] [--json]
//
// The report (worm.ts, restoreReport) names, per org, the journal entries, vouchers, document voids, number
// allocations, number voids and series the archive holds and the database lacks, the batches written after the backup
// point, and the series whose next number is not above the highest the archive holds for them (version 7 batches).
// The references carry ids only, so a lost row's legal entity is not known; a series' is.
// --reseed raises each of those series, one command each (kernel.number.reseed, audited, system actor): its next number
// becomes the archived highest + 1, and a series the restore lost is created again with its archived id and key. It
// never lowers a number. An org with lost allocations that no version 7 batch covers (the archive ends before the
// first one) cannot be reseeded from the archive: the operator reads the highest number of each of its series from
// the issued vouchers and passes it as a --floor (the next number to give), which --reseed applies too. Such an org is
// done only with a floor for every series the restored database has for it, and --floors-complete <org id>, by which
// the operator confirms that every series it numbered after the backup point (made since, so in the vouchers only) has
// one too.
// --acknowledge (#2020), once every series is safe: writes the acknowledgement of the restore to the archive store, the
// rows the report names as lost, which the nightly verifier then excuses and nothing else, and records the batches
// written after the backup point in the restored database (worm.ts, acknowledgeRestore). restore.sh passes it.
// --json prints the report as JSON on stdout and the summary on stderr.
// Exit codes: 0 the archive and the database agree; 2 rows were lost and every series is above the archive (the
// report names what to reconcile); 3 a series is still behind, or an org needs a floor: keep writes closed; 1 the
// report could not run, or the archive does not match (a broken chain, a changed row, a recorded batch the store
// lacks).
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '@crove/db';
import { DomainError, defineCommand, type Actor, type CommandDef, type Runtime } from '@crove/kernel-runtime';
import { acknowledgeRestore, restoreReport, type ArchiveStore, type RestoreReport, type RestoreSeries, type UncoveredSeries } from './worm.ts';

export const RESTORE_REPORT_EXIT = { ok: 0, failed: 1, lost: 2, behind: 3 } as const;
const OPERATOR: Actor = { type: 'system', component: 'operator' };
// Ids printed per kind in the summary; --json has them all.
const SHOWN = 20;

const zNumber = z.string().regex(/^[1-9][0-9]{0,17}$/);
const zReseed = z.strictObject({
  // The archived series id, for a series the restore lost; null for a floor the operator names by its key.
  seriesId: z.uuid().nullable(),
  legalEntityId: z.uuid(),
  docType: z.string().regex(/^[a-z][a-z0-9_.]*$/).max(100),
  periodKey: z.string().regex(/^(\d{4}|\d{4}-(0[1-9]|1[0-2])|-)$/),
  next: zNumber,
  // Where the number comes from: the archive's highest + 1, or an operator's floor.
  source: z.enum(['archive', 'floor']),
  archivedHigh: zNumber.nullable(),
});

// The definer's refusals, in words the operator reads in the restore log.
const RESEED_REFUSALS: Record<string, string> = {
  NUMBER_RESEED_PERIOD_MISFIT: 'Kỳ đánh số không khớp cách đánh số của loại chứng từ (chính sách đặt sau bản sao lưu đã mất)',
  LEGAL_ENTITY_NOT_ALLOWED: 'Pháp nhân không có trong tổ chức này',
  NUMBER_INPUT_INVALID: 'Số tiếp theo không hợp lệ',
};

export interface NumberReseeded {
  seriesId: string;
  previousNext: string | null;
  next: string;
}

// The command, for the operator's runtime only. System actor only; the definer checks again that the session is the
// worker's and the context the org's system context.
export function numberReseedCommand(): CommandDef<z.infer<typeof zReseed>, NumberReseeded> {
  return defineCommand({
    name: 'kernel.number.reseed',
    input: zReseed,
    risk: 'R2',
    // Internal: it raises a counter of the numbering tables; no document, posting or outside system changes.
    sideEffect: 'internal',
    access: 'system',
    handler: async (ctx, input) => {
      const { rows } = await sql<{ series_id: string; previous_next: string | null; next_number: string }>`
        SELECT series_id, previous_next::text AS previous_next, next_number::text AS next_number
        FROM crove_kernel.number_series_reseed(${input.seriesId}::uuid, ${input.legalEntityId}::uuid, ${input.docType}, ${input.periodKey},
          ${input.next}::bigint)`
        .execute(ctx.trx)
        .catch((error: { message?: string }) => {
          const refusal = error?.message && RESEED_REFUSALS[error.message];
          if (refusal) throw new DomainError(error.message as string, 422, refusal);
          throw error;
        });
      const row = rows[0];
      if (!row) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      ctx.audit({
        seriesId: row.series_id,
        legalEntityId: input.legalEntityId,
        docType: input.docType,
        periodKey: input.periodKey,
        source: input.source,
        archivedHigh: input.archivedHigh,
        previousNext: row.previous_next,
        next: row.next_number,
      });
      return { seriesId: row.series_id, previousNext: row.previous_next, next: row.next_number };
    },
  });
}

export interface RestoreFloor {
  orgId: string;
  legalEntityId: string;
  docType: string;
  periodKey: string;
  next: string;
}

export interface RestoreReportArgs {
  reseed: boolean;
  json: boolean;
  floors: RestoreFloor[];
  // The orgs whose floors the operator confirms complete: every series they numbered after the backup point has one.
  floorsComplete: string[];
  acknowledge: boolean;
}

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLOOR = /^([0-9a-f-]{36}):([0-9a-f-]{36}):([a-z][a-z0-9_.]*):([0-9]{4}(?:-(?:0[1-9]|1[0-2]))?|-)=([1-9][0-9]{0,17})$/;

export function parseRestoreReportArgs(argv: readonly string[]): RestoreReportArgs {
  const args: RestoreReportArgs = { reseed: false, json: false, floors: [], floorsComplete: [], acknowledge: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--reseed') args.reseed = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--acknowledge') args.acknowledge = true;
    else if (arg === '--floor') {
      const match = FLOOR.exec((argv[++i] ?? '').trim().toLowerCase());
      if (!match) throw new Error('--floor needs <org id>:<legal entity id>:<doc type>:<period key>=<next number>');
      const [, orgId = '', legalEntityId = '', docType = '', periodKey = '', next = ''] = match;
      args.floors.push({ orgId, legalEntityId, docType, periodKey, next });
    } else if (arg === '--floors-complete') {
      const orgId = (argv[++i] ?? '').trim().toLowerCase();
      if (!ORG_ID.test(orgId)) throw new Error('--floors-complete needs an org id');
      args.floorsComplete.push(orgId);
    } else {
      throw new Error(
        `unknown argument ${arg}; use [--reseed] [--floor <org id>:<legal entity id>:<doc type>:<period key>=<next number>]... [--floors-complete <org id>]... [--acknowledge] [--json]`,
      );
    }
  }
  if ((args.floors.length > 0 || args.floorsComplete.length > 0) && !args.reseed) throw new Error('--floor and --floors-complete take effect with --reseed only');
  return args;
}

export interface RestoreReportDeps {
  db: Db;
  store: ArchiveStore;
  runtime: Pick<Runtime, 'execute'>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  out?: (text: string) => void;
}

export interface RestoreReportOutcome {
  report: RestoreReport;
  reseeded: Array<RestoreSeries & { source: 'archive' } | RestoreFloor & { source: 'floor' }>;
  // Series still behind the archive (with the reason when the reseed refused one), floors the reseed refused, and orgs
  // that still need a floor.
  behind: RestoreSeries[];
  failedFloors: Array<RestoreFloor & { reason: string }>;
  // Orgs not yet done, each restored series of theirs still without a floor, and the orgs whose floors the operator has
  // not confirmed complete.
  needFloor: string[];
  missingFloors: UncoveredSeries[];
  unconfirmed: string[];
  // The key of the acknowledgement written (or found) with --acknowledge; null when none was.
  acknowledged: string | null;
}

const ids = (list: string[]) => (list.length <= SHOWN ? list.join(' ') : `${list.slice(0, SHOWN).join(' ')} and ${list.length - SHOWN} more`);
const nextAfter = (high: string) => (BigInt(high) + 1n).toString();
const reasonOf = (e: unknown) => (e instanceof DomainError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

// The report, and with --reseed the series raised. Throws when it cannot run. An archive with a problem (a broken
// chain, an edited batch, a version regression) is not trusted: nothing is raised, from it or from a floor, and the
// run exits 1. Each series is raised in a command of its own: one the reseed refuses stays behind with its reason, and
// the others are still raised.
export async function restoreCheck(deps: RestoreReportDeps, args: RestoreReportArgs): Promise<RestoreReportOutcome> {
  const report = await restoreReport(deps.db, deps.store);
  const reseeded: RestoreReportOutcome['reseeded'] = [];
  const behind: RestoreSeries[] = [];
  const failedFloors: RestoreReportOutcome['failedFloors'] = [];
  const trusted = args.reseed && report.problems.length === 0;
  if (trusted) {
    for (const series of report.reseed) {
      try {
        await deps.runtime.execute<NumberReseeded>(
          'kernel.number.reseed',
          {
            seriesId: series.seriesId,
            legalEntityId: series.legalEntityId,
            docType: series.docType,
            periodKey: series.periodKey,
            next: nextAfter(series.archivedHigh),
            source: 'archive',
            archivedHigh: series.archivedHigh,
          },
          { actor: OPERATOR, orgId: series.orgId },
        );
        reseeded.push({ ...series, source: 'archive' });
      } catch (e) {
        behind.push({ ...series, reason: reasonOf(e) });
      }
    }
    for (const floor of args.floors) {
      const { orgId, ...key } = floor;
      try {
        await deps.runtime.execute<NumberReseeded>('kernel.number.reseed', { seriesId: null, ...key, source: 'floor', archivedHigh: null }, { actor: OPERATOR, orgId });
        reseeded.push({ ...floor, source: 'floor' });
      } catch (e) {
        failedFloors.push({ ...floor, reason: reasonOf(e) });
      }
    }
  } else {
    behind.push(...report.reseed);
  }
  // An org the archive does not cover is done with a floor raised for every series the restored database has for it,
  // and the operator's word (--floors-complete) that every series it numbered after the backup point has one too.
  const key = (s: { orgId: string; legalEntityId: string; docType: string; periodKey: string }) => `${s.orgId}|${s.legalEntityId}|${s.docType}|${s.periodKey}`;
  const raised = new Set(reseeded.filter((r) => r.source === 'floor').map(key));
  const missingFloors = report.uncoveredSeries.filter((s) => !raised.has(key(s)));
  const confirmed = new Set(trusted ? args.floorsComplete : []);
  const unconfirmed = report.uncovered.filter((org) => !confirmed.has(org));
  const needFloor = report.uncovered.filter((org) => unconfirmed.includes(org) || missingFloors.some((s) => s.orgId === org));
  // The acknowledgement only once nothing can give out an archived number again: it lets the verifier pass, and the
  // archiver go on from the store's newest batch.
  const safe = report.problems.length === 0 && behind.length === 0 && failedFloors.length === 0 && needFloor.length === 0;
  const acknowledged = args.acknowledge && safe ? await acknowledgeRestore(deps.db, deps.store, report) : null;
  return { report, reseeded, behind, failedFloors, needFloor, missingFloors, unconfirmed, acknowledged };
}

export function restoreReportLines(outcome: RestoreReportOutcome): string[] {
  const { report } = outcome;
  const lines = [
    `archive: ${report.batches} batch(es) in the store, the restored database recorded up to ${report.recorded}; ${report.beyond.length} written after the backup point` +
      (report.beyond.length > 0 ? ` (${report.beyond[0]?.from} to ${report.beyond.at(-1)?.to})` : ''),
  ];
  for (const problem of report.problems) lines.push(`PROBLEM: ${problem.code} in batch ${problem.seq}${problem.ref ? ` (${problem.ref})` : ''}`);
  if (report.auditEvents > 0) lines.push(`lost: ${report.auditEvents} audit event(s)`);
  for (const org of report.orgs) {
    const kinds: Array<[string, string[]]> = [
      ['journal entries', org.journalEntries],
      ['cash vouchers', org.cashVouchers],
      ['journal vouchers', org.journalVouchers],
      ['document voids', org.documentVoids],
      ['number allocations', org.allocations],
      ['number voids', org.numberVoids],
      ['number series', org.series],
    ];
    for (const [name, list] of kinds) if (list.length > 0) lines.push(`lost in org ${org.orgId}: ${list.length} ${name}: ${ids(list)}`);
  }
  for (const s of outcome.reseeded) {
    lines.push(
      s.source === 'archive'
        ? `reseeded: org ${s.orgId} series ${s.seriesId} (${s.legalEntityId} ${s.docType} ${s.periodKey}) next ${nextAfter(s.archivedHigh)}, above the archived ${s.archivedHigh} (was ${s.next ?? 'lost'})`
        : `reseeded: org ${s.orgId} series ${s.legalEntityId} ${s.docType} ${s.periodKey} next at least ${s.next}, the operator's floor`,
    );
  }
  for (const s of outcome.behind) {
    lines.push(
      `BEHIND: org ${s.orgId} series ${s.seriesId} (${s.legalEntityId} ${s.docType} ${s.periodKey}) next ${s.next ?? 'lost'}, the archive holds ${s.archivedHigh}: ` +
        (s.reason ? `the reseed refused it (${s.reason}); name a --floor once the cause is fixed` : 'run with --reseed'),
    );
  }
  for (const f of outcome.failedFloors) {
    lines.push(`FLOOR REFUSED: org ${f.orgId} series ${f.legalEntityId} ${f.docType} ${f.periodKey} next ${f.next}: ${f.reason}`);
  }
  for (const s of outcome.report.orphaned) {
    lines.push(
      `lost with its org or legal entity: org ${s.orgId} series ${s.seriesId} (${s.legalEntityId} ${s.docType} ${s.periodKey}), the archive holds up to ${s.archivedHigh}; ` +
        'if the entity is entered again, give its series a --floor above that',
    );
  }
  for (const s of outcome.missingFloors) {
    lines.push(
      `NEEDS A FLOOR: org ${s.orgId} series ${s.legalEntityId} ${s.docType} ${s.periodKey} (restored next ${s.next}): no version 7 batch covers the org's lost numbers; ` +
        `pass --floor ${s.orgId}:${s.legalEntityId}:${s.docType}:${s.periodKey}=<next number> from the issued vouchers`,
    );
  }
  for (const org of outcome.unconfirmed) {
    lines.push(
      `NEEDS A FLOOR: org ${org} lost number allocations that no version 7 batch covers; once every series it numbered after the backup point has a --floor ` +
        `(those made since are in the issued vouchers only), pass --floors-complete ${org}`,
    );
  }
  if (outcome.acknowledged) {
    lines.push(
      `acknowledged: ${report.acknowledgedRefs.length} row(s) lost to restores, ${report.lostRefs.length} of them to this one, in ${outcome.acknowledged}; ` +
        'the nightly verification excuses exactly those, and the batches after the backup point are recorded',
    );
  }
  lines.push('provider-issued numbers (e-invoices) are not in the archive: reconcile them with the provider (docs/runbooks/ledger-after-restore.md)');
  return lines;
}

export function restoreReportExit(outcome: RestoreReportOutcome): number {
  const { report } = outcome;
  if (report.problems.length > 0) return RESTORE_REPORT_EXIT.failed;
  if (outcome.behind.length > 0 || outcome.failedFloors.length > 0 || outcome.needFloor.length > 0) return RESTORE_REPORT_EXIT.behind;
  if (report.auditEvents > 0 || report.orgs.length > 0) return RESTORE_REPORT_EXIT.lost;
  return RESTORE_REPORT_EXIT.ok;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export async function runRestoreReport(deps: RestoreReportDeps, argv: readonly string[]): Promise<number> {
  const error = deps.error ?? ((line: string) => console.error(line));
  let args: RestoreReportArgs;
  try {
    args = parseRestoreReportArgs(argv);
  } catch (e) {
    error(`[restore-report] ${e instanceof Error ? e.message : String(e)}`);
    return RESTORE_REPORT_EXIT.failed;
  }
  // With --json the summary goes to stderr, so stdout holds the JSON alone.
  const log = deps.log ?? (args.json ? (line: string) => console.error(line) : (line: string) => console.log(line));
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  try {
    const outcome = await restoreCheck(deps, args);
    for (const line of restoreReportLines(outcome)) log(`[restore-report] ${line}`);
    if (args.json) {
      const { report, ...rest } = outcome;
      out(`${JSON.stringify({ ...report, ...rest })}\n`);
    }
    return restoreReportExit(outcome);
  } catch (e) {
    error(`[restore-report] ${oneLine(e instanceof Error ? e.message : String(e))}`);
    return RESTORE_REPORT_EXIT.failed;
  }
}
