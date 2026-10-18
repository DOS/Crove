// Period lock (issue #329, ADR-0021 section 3): filed months must not change silently. An org locks its books one
// month at a time, in order, and unlocks the last locked month first; nothing posts with an entry date up to the end
// of the last locked month (20261019200000_crove_finance_period_lock.sql holds every writer to it).
// - finance.period.lock_state: every member reads what is locked (the ledger screen shows it).
// - finance.period.lock: owners and admins lock the next month, once it has ended (in Vietnam time). R2, as ADR-0021
//   section 7 has the close: no step-up, and an agent may only propose it.
// - finance.period.unlock: owners only, R3 (fresh MFA, P11) with a reason, which the audit row records together with
//   the month. The audit rows of both commands are the history of the lock.
// A refused posting answers PERIOD_LOCKED (ledger.ts), so recording, approving, reversing and importing opening
// balances into a locked month all say why.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zPeriodLockInput, zPeriodUnlockInput, type PeriodLockState } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const LOCKERS: readonly MemberRole[] = ['owner', 'admin'];
export const PERIOD_TIME_ZONE = 'Asia/Ho_Chi_Minh';

// 'YYYY-MM' of `date` in Vietnam.
export function vietnamMonth(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: PERIOD_TIME_ZONE, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}`;
}

// 'YYYY-MM' of a YYYY-MM-DD date, and the month after or before one.
export const monthOf = (date: string) => date.slice(0, 7);
export function shiftMonth(month: string, by: 1 | -1): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export async function periodLockState(ctx: QueryContext): Promise<PeriodLockState> {
  const row = await ctx.trx
    .selectFrom('crove_finance.period_lock')
    .select(['locked_from', 'locked_through', 'updated_by', 'updated_at'])
    .where('org_id', '=', ctx.orgId)
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
    lockedFrom: row?.locked_from ?? null,
    lockedThrough,
    // The month the next lock must name (null: any month that has ended), and the one an unlock must name.
    nextMonth: lockedThrough ? shiftMonth(monthOf(lockedThrough), 1) : null,
    lastMonth: lockedThrough ? monthOf(lockedThrough) : null,
    // The last lock or unlock; a row the posting guard created has neither.
    updatedBy,
    updatedAt: row?.updated_by ? row.updated_at.toISOString() : null,
  };
}

export const periodLockStateQuery = defineQuery({
  name: 'finance.period.lock_state',
  input: z.object({}),
  access: ALL,
  handler: (ctx): Promise<PeriodLockState> => periodLockState(ctx),
});

const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
const dateLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

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

// The refusals of lock_period() and unlock_period() (P0001 with the current locked_through as JSON detail) as the
// domain errors the commands answer. Anything else is rethrown for the runtime to map.
function lockRefusal(error: unknown, month: string): never {
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
    }
  }
  throw error;
}

export const periodLock = defineCommand({
  name: 'finance.period.lock',
  input: zPeriodLockInput,
  risk: 'R2',
  access: LOCKERS,
  handler: async (ctx, input): Promise<PeriodLockState> => {
    ctx.audit({ month: input.month });
    try {
      await sql`SELECT crove_finance.lock_period(${`${input.month}-01`}::date)`.execute(ctx.trx);
    } catch (error) {
      lockRefusal(error, input.month);
    }
    // A month is locked once it is over, so the entries of its last days can still be posted. Checked after the order
    // (the refusal rolls the lock back), so a month out of order says which month comes first.
    if (input.month >= vietnamMonth(ctx.now)) {
      throw new DomainError('PERIOD_NOT_ENDED', 422, `Tháng ${monthLabel(input.month)} chưa kết thúc nên chưa khóa sổ được`, { month: input.month });
    }
    await ctx.activity('finance.period', ctx.orgId, 'period.locked', `Khóa sổ tháng ${monthLabel(input.month)}`);
    return periodLockState(ctx);
  },
});

export const periodUnlock = defineCommand({
  name: 'finance.period.unlock',
  input: zPeriodUnlockInput,
  risk: 'R3',
  access: ['owner'],
  handler: async (ctx, input): Promise<PeriodLockState> => {
    ctx.audit({ month: input.month, reason: input.reason });
    try {
      await sql`SELECT crove_finance.unlock_period(${`${input.month}-01`}::date)`.execute(ctx.trx);
    } catch (error) {
      lockRefusal(error, input.month);
    }
    await ctx.activity('finance.period', ctx.orgId, 'period.unlocked', `Mở khóa sổ tháng ${monthLabel(input.month)} (lý do: ${input.reason})`);
    return periodLockState(ctx);
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
    `Sổ đã khóa đến hết ngày ${through ? dateLabel(through) : ''}, nên không ghi được bút toán ngày ${entryDate ? dateLabel(entryDate) : ''}. Chủ sở hữu có thể mở khóa tháng đó nếu cần sửa.`,
    { lockedThrough: through, entryDate },
  );
}
