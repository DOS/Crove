// SPDX-License-Identifier: AGPL-3.0-only
// The `restore-report` image role (issue #2007, plan §7.9): after a restore, what the WORM archive holds that the
// restored database lacks, and the number series raised above the numbers the archive holds. tools/backup/restore.sh
// runs it in the worker's container before the stack starts, and an operator may run it again at any time (the worker
// login is the only role that may read the archive hashes and run the reseed):
//
//   restore-report [--reseed] [--floor <org id>:<legal entity id>:<doc type>:<period key>=<next number>]... [--json]
//
// The report (worm.ts, restoreReport) names, per org, the journal entries, vouchers, document voids, number
// allocations, number voids and series the archive holds and the database lacks, the batches written after the backup
// point, and the series whose next number is not above the highest the archive holds for them (version 7 batches).
// The references carry ids only, so a lost row's legal entity is not known; a series' is.
// --reseed raises each of those series, one command each (kernel.number.reseed, audited, system actor): its next number
// becomes the archived highest + 1, and a series the restore lost is created again with its archived id and key. It
// never lowers a number. An org with lost allocations that no version 7 batch covers (the archive ends before the
// first one) cannot be reseeded from the archive: the operator reads the highest number of each of its series from
// the issued vouchers and passes it as a --floor (the next number to give), which --reseed applies too.
// --json prints the report as JSON on stdout and the summary on stderr.
// Exit codes: 0 the archive and the database agree; 2 rows were lost and every series is above the archive (the
// report names what to reconcile); 3 a series is still behind, or an org needs a floor: keep writes closed; 1 the
// report could not run, or the archive does not match (a broken chain, a changed row, a recorded batch the store
// lacks).
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '@crove/db';
import { DomainError, defineCommand, type Actor, type CommandDef, type Runtime } from '@crove/kernel-runtime';
import { restoreReport, type ArchiveStore, type RestoreReport, type RestoreSeries } from './worm.ts';

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
    target: (input) => (input.seriesId ? { type: 'kernel.number_series', id: input.seriesId } : null),
    handler: async (ctx, input) => {
      const { rows } = await sql<{ series_id: string; previous_next: string | null; next_number: string }>`
        SELECT series_id, previous_next::text AS previous_next, next_number::text AS next_number
        FROM crove_kernel.number_series_reseed(${input.seriesId}::uuid, ${input.legalEntityId}::uuid, ${input.docType}, ${input.periodKey},
          ${input.next}::bigint)`.execute(ctx.trx);
      const row = rows[0];
      if (!row) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      const result = { seriesId: row.series_id, previousNext: row.previous_next, next: row.next_number };
      ctx.audit({ ...input, ...result });
      return result;
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
}

const FLOOR = /^([0-9a-f-]{36}):([0-9a-f-]{36}):([a-z][a-z0-9_.]*):([0-9]{4}(?:-(?:0[1-9]|1[0-2]))?|-)=([1-9][0-9]{0,17})$/;

export function parseRestoreReportArgs(argv: readonly string[]): RestoreReportArgs {
  const args: RestoreReportArgs = { reseed: false, json: false, floors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--reseed') args.reseed = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--floor') {
      const match = FLOOR.exec((argv[++i] ?? '').trim().toLowerCase());
      if (!match) throw new Error('--floor needs <org id>:<legal entity id>:<doc type>:<period key>=<next number>');
      const [, orgId = '', legalEntityId = '', docType = '', periodKey = '', next = ''] = match;
      args.floors.push({ orgId, legalEntityId, docType, periodKey, next });
    } else throw new Error(`unknown argument ${arg}; use [--reseed] [--floor <org id>:<legal entity id>:<doc type>:<period key>=<next number>]... [--json]`);
  }
  if (args.floors.length > 0 && !args.reseed) throw new Error('--floor takes effect with --reseed only');
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
  // Series still behind the archive, and orgs that still need a floor.
  behind: RestoreSeries[];
  needFloor: string[];
}

const ids = (list: string[]) => (list.length <= SHOWN ? list.join(' ') : `${list.slice(0, SHOWN).join(' ')} and ${list.length - SHOWN} more`);
const nextAfter = (high: string) => (BigInt(high) + 1n).toString();

// The report, and with --reseed the series raised. Throws when it cannot run.
export async function restoreCheck(deps: RestoreReportDeps, args: RestoreReportArgs): Promise<RestoreReportOutcome> {
  const report = await restoreReport(deps.db, deps.store);
  const reseeded: RestoreReportOutcome['reseeded'] = [];
  const behind: RestoreSeries[] = [];
  if (args.reseed) {
    for (const series of report.reseed) {
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
    }
    for (const floor of args.floors) {
      const { orgId, ...key } = floor;
      await deps.runtime.execute<NumberReseeded>('kernel.number.reseed', { seriesId: null, ...key, source: 'floor', archivedHigh: null }, { actor: OPERATOR, orgId });
      reseeded.push({ ...floor, source: 'floor' });
    }
  } else {
    behind.push(...report.reseed);
  }
  const floored = new Set(args.reseed ? args.floors.map((f) => f.orgId) : []);
  return { report, reseeded, behind, needFloor: report.uncovered.filter((org) => !floored.has(org)) };
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
    lines.push(`BEHIND: org ${s.orgId} series ${s.seriesId} (${s.legalEntityId} ${s.docType} ${s.periodKey}) next ${s.next ?? 'lost'}, the archive holds ${s.archivedHigh}: run with --reseed`);
  }
  for (const org of outcome.needFloor) {
    lines.push(`NEEDS A FLOOR: org ${org} lost number allocations that no version 7 batch covers; pass --floor for each of its series from the issued vouchers`);
  }
  lines.push('provider-issued numbers (e-invoices) are not in the archive: reconcile them with the provider (docs/runbooks/ledger-after-restore.md)');
  return lines;
}

export function restoreReportExit(outcome: RestoreReportOutcome): number {
  const { report } = outcome;
  if (report.problems.length > 0) return RESTORE_REPORT_EXIT.failed;
  if (outcome.behind.length > 0 || outcome.needFloor.length > 0) return RESTORE_REPORT_EXIT.behind;
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
    if (args.json) out(`${JSON.stringify({ ...outcome.report, reseeded: outcome.reseeded, behind: outcome.behind, needFloor: outcome.needFloor })}\n`);
    return restoreReportExit(outcome);
  } catch (e) {
    error(`[restore-report] ${oneLine(e instanceof Error ? e.message : String(e))}`);
    return RESTORE_REPORT_EXIT.failed;
  }
}
