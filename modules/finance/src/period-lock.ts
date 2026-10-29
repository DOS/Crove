// Period lock (issue #329, ADR-0021 section 3): filed months must not change silently. An org locks its books one
// month at a time, in order, and unlocks the last locked month first; nothing posts with an entry date up to the end
// of the last locked month (20261020070000_crove_finance_period_lock.sql holds every writer to it).
// - finance.period.lock_state: every member reads what is locked (the ledger screen shows it).
// - finance.period.lock: owners and admins lock the next month, once it has ended (in Vietnam time, by the database
//   clock). R2, as ADR-0021 section 7 has the close: no step-up, and an agent may only propose it.
// - finance.period.unlock: owners and chief accountants (#1279), R3 (fresh MFA, P11) with a reason, which the audit
//   row records together with the month. The audit rows of both commands are the history of the lock.
// A refused posting answers PERIOD_LOCKED (ledger.ts), so recording, approving, reversing and importing opening
// balances into a locked month all say why. The same guard keeps the opening entry first (#366): an entry dated on or
// before it answers BEFORE_OPENING_BALANCE (openingEntryError below).
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { VIETNAM_TIME_ZONE, zLegalEntityChoice, zPeriodLockInput, zPeriodUnlockInput, type PeriodLockState } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { legalEntityError, resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const LOCKERS: readonly MemberRole[] = ['owner', 'admin'];

// Today in Vietnam by the database clock, as 'YYYY-MM-DD' (#560). The rules about "today" that go with the lock read
// this clock, never the kernel process's: lock_period() refuses a month that has not ended by pg_catalog.now(), and a
// late posting date may not be after this day (record.ts). now() is the transaction's start, one clock for every
// kernel process (theirs may drift apart), and the same one the lock and the posting guard run under, so the two
// rules cannot disagree around midnight. The SPA's hints use @crove/kernel-contract vietnamToday; the kernel decides.
export async function databaseToday(trx: QueryContext['trx']): Promise<string> {
  const { rows } = await sql<{ today: string }>`
    SELECT pg_catalog.to_char(pg_catalog.now() AT TIME ZONE ${VIETNAM_TIME_ZONE}::text, 'YYYY-MM-DD') AS today`.execute(trx);
  const today = rows[0]?.today;
  if (!today) throw new Error('the database did not answer the date');
  return today;
}

// 'YYYY-MM' of a YYYY-MM-DD date, and the month after or before one.
export const monthOf = (date: string) => date.slice(0, 7);
export function shiftMonth(month: string, by: 1 | -1): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// The lock of one legal entity (#1280: each entity locks its own months): the one named, else resolveLegalEntity's.
export async function periodLockState(ctx: QueryContext, legalEntityId?: string): Promise<PeriodLockState> {
  const entity = await resolveLegalEntity(ctx, legalEntityId);
  const row = await ctx.trx
    .selectFrom('crove_finance.period_lock')
    .select(['locked_from', 'locked_through', 'updated_by', 'updated_at'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .executeTakeFirst();
  const lockedThrough = row?.locked_through ?? null;
  // Who locked or unlocked last, by name while they are a member (crove_kernel.member_profiles answers only members).
  let updatedBy: string | null = null;
  if (row?.updated_by) {
    const { rows } = await sql<{ email: string; display_name: string | null }>`
      SELECT email, display_name FROM crove_kernel.member_profiles(${[row.updated_by]}::uuid[])`.execute(ctx.trx);
    updatedBy = rows[0] ? (rows[0].display_name ?? rows[0].email) : null;
  }
  return {
    legalEntityId: entity,
    lockedFrom: row?.locked_from ?? null,
    lockedThrough,
    // The month the next lock must name (null: any month that has ended), and the one an unlock must name.
    nextMonth: lockedThrough ? shiftMonth(monthOf(lockedThrough), 1) : null,
    lastMonth: lockedThrough ? monthOf(lockedThrough) : null,
    // The last lock or unlock; a row the posting guard created has neither.
    updatedBy,
    updatedAt: row?.updated_by ? row.updated_at.toISOString() : null,
    // The opening entry in force (#366): nothing else posts on or before it.
    openingDate: await liveOpeningDate(ctx, entity),
  };
}

export const periodLockStateQuery = defineQuery({
  name: 'finance.period.lock_state',
  input: zLegalEntityChoice,
  access: ALL,
  handler: (ctx, input): Promise<PeriodLockState> => periodLockState(ctx, input.legalEntityId),
});

const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
export const dateLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

interface PgError {
  code?: string;
  message?: string;
  detail?: string;
}

function lockedThroughOf(error: PgError): string | null {
  try {
    const parsed = JSON.parse(error.detail ?? '{}') as { lockedThrough?: unknown };
    return typeof parsed.lockedThrough === 'string' ? parsed.lockedThrough : null;
  } catch {
    return null;
  }
}

const notEnded = (month: string) =>
  new DomainError('PERIOD_NOT_ENDED', 422, `Tháng ${monthLabel(month)} chưa kết thúc nên chưa khóa sổ được`, { month });

// The refusals of lock_period() and unlock_period() (P0001 with the current locked_through as JSON detail) as the
// domain errors the commands answer. Anything else is rethrown for the runtime to map.
function lockRefusal(error: unknown, month: string): never {
  const entityError = legalEntityError(error);
  if (entityError) throw entityError;
  const pg = error as PgError;
  if (pg?.code === 'P0001') {
    const through = lockedThroughOf(pg);
    const details = { month, lockedThrough: through };
    const last = through ? monthLabel(monthOf(through)) : null;
    switch (pg.message) {
      case 'PERIOD_ALREADY_LOCKED':
        throw new DomainError('PERIOD_ALREADY_LOCKED', 409, `Tháng ${monthLabel(month)} đã khóa sổ`, details);
      case 'EARLIER_PERIOD_OPEN':
        throw new DomainError(
          'EARLIER_PERIOD_OPEN',
          409,
          `Sổ đã khóa đến hết tháng ${last}; hãy khóa lần lượt từng tháng, bắt đầu từ tháng ${through ? monthLabel(shiftMonth(monthOf(through), 1)) : ''}`,
          details,
        );
      case 'PERIOD_NOT_LOCKED':
        throw new DomainError('PERIOD_NOT_LOCKED', 409, `Tháng ${monthLabel(month)} chưa khóa sổ`, details);
      case 'LATER_PERIOD_LOCKED':
        throw new DomainError('LATER_PERIOD_LOCKED', 409, `Hãy mở khóa tháng ${last} trước: chỉ mở khóa được tháng khóa sau cùng`, details);
      case 'PERIOD_NOT_ENDED':
        throw notEnded(month);
    }
  }
  throw error;
}

export const periodLock = defineCommand({
  name: 'finance.period.lock',
  input: zPeriodLockInput,
  // A reversible write (unlock reopens the month); R2 is the policy of ADR-0021 section 7, above what it derives.
  risk: 'R2',
  sideEffect: 'internal',
  access: LOCKERS,
  handler: async (ctx, input): Promise<PeriodLockState> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    ctx.audit({ month: input.month, legalEntityId: entity });
    // A month is locked once it is over, so the entries of its last days can still be posted. lock_period() decides by
    // the database clock (databaseToday above says why that clock), after the order, so a month out of order says which
    // month comes first.
    try {
      await sql`SELECT crove_finance.lock_period(${`${input.month}-01`}::date, ${entity}::uuid)`.execute(ctx.trx);
    } catch (error) {
      lockRefusal(error, input.month);
    }
    // The month is the entity's: its row is read only where that entity is (#1725).
    await ctx.activity('finance.period', ctx.orgId, 'period.locked', `Khóa sổ tháng ${monthLabel(input.month)}`, { legalEntityId: entity });
    return periodLockState(ctx, entity);
  },
});

export const periodUnlock = defineCommand({
  name: 'finance.period.unlock',
  input: zPeriodUnlockInput,
  // Reopens a month for postings, a reversible write; R3 (fresh second factor, a reason) is the policy of ADR-0021
  // section 7, above what it derives.
  risk: 'R3',
  sideEffect: 'internal',
  access: ['owner'],
  // ADR-0021 section 3: the chief accountant reopens a period too (an org-wide finance.chief_accountant assignment,
  // #1279); unlock_period() checks the same again.
  permission: 'finance.period.unlock',
  handler: async (ctx, input): Promise<PeriodLockState> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    ctx.audit({ month: input.month, reason: input.reason, legalEntityId: entity });
    try {
      await sql`SELECT crove_finance.unlock_period(${`${input.month}-01`}::date, ${entity}::uuid)`.execute(ctx.trx);
    } catch (error) {
      lockRefusal(error, input.month);
    }
    await ctx.activity('finance.period', ctx.orgId, 'period.unlocked', `Mở khóa sổ tháng ${monthLabel(input.month)} (lý do: ${input.reason})`, {
      legalEntityId: entity,
    });
    return periodLockState(ctx, entity);
  },
});

// The answer to a posting the guard refused (55000 PERIOD_LOCKED with the locked_through and entry date as JSON
// detail), or null for any other error.
export function periodLockedError(error: unknown): DomainError | null {
  const pg = error as PgError;
  if (pg?.code !== '55000' || pg.message !== 'PERIOD_LOCKED') return null;
  const through = lockedThroughOf(pg);
  let entryDate: string | null = null;
  try {
    const parsed = JSON.parse(pg.detail ?? '{}') as { entryDate?: unknown };
    entryDate = typeof parsed.entryDate === 'string' ? parsed.entryDate : null;
  } catch {
    entryDate = null;
  }
  return new DomainError(
    'PERIOD_LOCKED',
    409,
    `Sổ đã khóa đến hết ngày ${through ? dateLabel(through) : ''}, nên không ghi được bút toán ngày ${entryDate ? dateLabel(entryDate) : ''}. Chủ sở hữu hoặc kế toán trưởng có thể mở khóa tháng đó nếu cần sửa.`,
    { lockedThrough: through, entryDate },
  );
}

// A string field of the guard's JSON detail, or null.
function detailField(error: PgError, key: string): string | null {
  try {
    const value = (JSON.parse(error.detail ?? '{}') as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

// How a posting can answer an entry dated on or before the opening entry, so the refusal tells the user what to do:
// - posting_date: a purchase invoice, whose approver may choose a later posting date (record.ts, #478);
// - fixed: a document posted on its own date, which nobody chooses (a sales invoice, a voucher made from a bank
//   statement line): it must be dated after the opening balances, or the opening balances reversed and imported again
//   at an earlier date;
// - later_date: anything whose date the user enters (a cash voucher, a reversal).
// The SPA words each case through the rule in the details (apps/app/src/lib/kernel-errors.ts).
export const BEFORE_OPENING_CHOICES = ['posting_date', 'fixed', 'later_date'] as const;
export type BeforeOpeningChoice = (typeof BEFORE_OPENING_CHOICES)[number];

function beforeOpeningMessage(choice: BeforeOpeningChoice, openingDate: string, entryDate: string): string {
  const opening = `Số dư đầu kỳ đã ghi tại ngày ${openingDate}`;
  switch (choice) {
    case 'posting_date':
      return `${opening} nên hóa đơn không ghi sổ vào ngày ${entryDate} được. Hãy chọn ngày ghi sổ sau ngày ${openingDate}; chứng từ vẫn giữ ngày hóa đơn.`;
    case 'fixed':
      return `${opening} nên chứng từ ngày ${entryDate} không ghi sổ được. Chứng từ này ghi sổ theo đúng ngày của nó, không chọn được ngày khác, nên phải có ngày sau ngày số dư đầu kỳ. Nếu ngày số dư đầu kỳ chưa đúng, hãy đảo bút toán số dư đầu kỳ rồi nhập lại với ngày sớm hơn.`;
    case 'later_date':
      return `${opening} nên không ghi được bút toán ngày ${entryDate}. Hãy chọn một ngày sau ngày ${openingDate}.`;
  }
}

// The answer to a posting the opening entry rule refused (#366, 20261020210000): an entry dated on or before the org's
// opening entry (55000 BEFORE_OPENING_BALANCE, worded for `choice`), or an opening entry while another is in force
// (55000 OPENING_BALANCE_EXISTS) or dated on or after another entry (55000 OPENING_BALANCE_AFTER_ENTRIES);
// finance.opening_balance.post says the last two first, unless an entry committed meanwhile.
// Null for any other error.
export function openingEntryError(error: unknown, choice: BeforeOpeningChoice = 'later_date'): DomainError | null {
  const pg = error as PgError;
  if (pg?.code !== '55000') return null;
  const entryDate = detailField(pg, 'entryDate');
  if (pg.message === 'BEFORE_OPENING_BALANCE') {
    const openingDate = detailField(pg, 'openingDate');
    return new DomainError(
      'BEFORE_OPENING_BALANCE',
      409,
      beforeOpeningMessage(choice, openingDate ? dateLabel(openingDate) : '', entryDate ? dateLabel(entryDate) : ''),
      { openingDate, entryDate, rule: `before_opening_${choice}` },
    );
  }
  if (pg.message === 'OPENING_BALANCE_EXISTS') {
    return new DomainError('OPENING_BALANCE_EXISTS', 409, 'Đã có bút toán số dư đầu kỳ; hãy đảo bút toán đó trước khi nhập lại', {
      entryId: detailField(pg, 'entryId'),
    });
  }
  if (pg.message === 'OPENING_BALANCE_AFTER_ENTRIES') {
    const firstEntryDate = detailField(pg, 'firstEntryDate');
    return new DomainError(
      'OPENING_BALANCE_AFTER_ENTRIES',
      422,
      `Đã có bút toán từ ngày ${firstEntryDate ? dateLabel(firstEntryDate) : ''}; ngày số dư đầu kỳ phải trước ngày đó`,
      { firstEntryDate },
    );
  }
  return null;
}

// The answer to any refusal of the posting guard on journal_entry: the period lock or the opening entry rule.
export function postingGuardError(error: unknown, choice: BeforeOpeningChoice = 'later_date'): DomainError | null {
  return periodLockedError(error) ?? openingEntryError(error, choice);
}

// The date of the org's opening entry in force (not reversed), or null: the same rule as the posting guard. Read after
// a posting, it cannot move before commit: the guard holds the org's period_lock row FOR SHARE, and an opening entry
// needs it FOR UPDATE.
// Of one legal entity (#1280: each entity has its own opening balances): the one named, else resolveLegalEntity's.
export async function liveOpeningDate(ctx: QueryContext, legalEntityId?: string): Promise<string | null> {
  const entity = await resolveLegalEntity(ctx, legalEntityId);
  const { rows } = await sql<{ opening: string | null }>`
    SELECT pg_catalog.max(o.entry_date)::text AS opening
    FROM crove_finance.journal_entry o
    WHERE o.org_id = ${ctx.orgId}::uuid AND o.legal_entity_id = ${entity}::uuid AND o.source_type = 'finance.opening_balance'
      AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id)`.execute(ctx.trx);
  return rows[0]?.opening ?? null;
}
