// The tax calendar of an org (issue #921): which recurring tax obligations apply to it, what is due soon or overdue,
// and what a member marked done. The rules are data in @crove/kernel-contract (tax-calendar.ts); this module keeps the
// org's choices (crove_kernel.tax_profile, one row per org) and the done marks (crove_kernel.tax_obligation_done).
//
// Each legal entity files its own returns (#1496): a mark is one entity's, and the org's obligation for a period is done
// once every legal entity the reader sees that owes it has marked it (taxDuesOf says which owe what). A reader limited
// to some entities (an external accountant's assignments) sees only their entities and their marks, so its calendar is
// theirs.
//
// The home screen (overview.ts) lists, per org, the obligations due in the next TAX_DUE_WINDOW_DAYS days and the ones
// overdue and not marked done, from the day the org first saved its profile (at most a year back): an org that just
// set its calendar is not shown a year of overdue returns it filed elsewhere.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  TAX_OBLIGATIONS,
  TAX_RULES,
  rulesOf,
  taxDues,
  zTaxObligationMark,
  zTaxProfile,
  type TaxDueView,
  type TaxObligation,
  type TaxProfile,
  type TaxProfileSettings,
  type VatFilingPeriod,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const MARKERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export const TAX_DUE_WINDOW_DAYS = 30;
// How far back an overdue obligation is still listed, and how many items one org lists at most.
const OVERDUE_DAYS = 365;
const MAX_DUES = 50;
const DAY_MS = 86_400_000;
// The permission that lets a chief accountant mark the VAT return filed (#1508), org-wide or for its legal entities.
const VAT_FILE_PERMISSION = 'finance.vat.file';

export const TAX_OBLIGATION_LABELS: Record<TaxObligation, string> = {
  vat_return: 'Tờ khai thuế GTGT',
  pit_withholding: 'Tờ khai thuế TNCN khấu trừ',
  cit_provisional: 'Tạm nộp thuế TNDN',
  cit_finalization: 'Quyết toán thuế TNDN',
  pit_finalization: 'Quyết toán thuế TNCN',
  financial_statements: 'Báo cáo tài chính năm',
  license_fee: 'Lệ phí môn bài',
};

export interface StoredTaxProfile extends TaxProfile {
  // The day (Vietnam time) the profile was first saved, or null when the org never saved one.
  since: string | null;
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const vietnamDay = (at: Date) => new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export async function readTaxProfile(ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<StoredTaxProfile> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.tax_profile')
    .select(['obligations', 'pit_filing_period', 'fiscal_year_end_month', 'created_at'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (!row) return { obligations: [], pitFilingPeriod: null, fiscalYearEndMonth: 12, since: null };
  return {
    obligations: row.obligations.filter((o): o is TaxProfile['obligations'][number] => o !== 'vat_return'),
    pitFilingPeriod: row.pit_filing_period,
    fiscalYearEndMonth: row.fiscal_year_end_month,
    since: vietnamDay(new Date(row.created_at)),
  };
}

// Who may mark an obligation done, for which legal entity (#1917). Owners, admins and members mark any obligation. With
// finance installed, the VAT return's mark is finance.vat.return_mark's (rpc.ts routes it there, #1400): owners and
// admins, and a holder of finance.vat.file org-wide or for that entity (#1508). The same rule as mayFileVat in
// modules/finance/src/vat.ts and crove_finance.vat_return_filed_guard, through the same context functions, so a due
// row offers the mark exactly where the server takes it. Only a user marks.
export async function markRule(
  ctx: Pick<QueryContext, 'trx' | 'actor' | 'role' | 'installed'>,
): Promise<(obligation: TaxObligation, legalEntityId: string) => boolean> {
  const user = ctx.actor.type === 'user';
  const marker = user && ctx.role !== null && MARKERS.includes(ctx.role);
  const filer = user && ctx.role !== null && ADMINS.includes(ctx.role);
  const viaFinance = ctx.installed('finance');
  let entities: readonly string[] = [];
  if (user && viaFinance && !filer) {
    const { rows } = await sql<{ entities: string[] | null }>`SELECT crove_kernel.ctx_permission_entities(${VAT_FILE_PERMISSION}) AS entities`.execute(ctx.trx);
    entities = rows[0]?.entities ?? [];
  }
  return (obligation, legalEntityId) => {
    if (obligation === 'vat_return' && viaFinance) return filer || entities.includes('*') || entities.includes(legalEntityId);
    return marker;
  };
}

/**
 * The org's obligations still to do as of `today`: due within the window, or overdue since the profile was first saved
 * (at most a year back), without a done mark; by due date. Without a saved profile, only the VAT return from today.
 */
export async function taxDuesOf(ctx: Pick<QueryContext, 'trx' | 'orgId' | 'actor' | 'role' | 'installed'>, vatFilingPeriod: VatFilingPeriod | null, today: string): Promise<TaxDueView[]> {
  const profile = await readTaxProfile(ctx);
  const settings: TaxProfileSettings = { ...profile, vatFilingPeriod };
  if (rulesOf(settings).length === 0) return [];
  const yearBack = addDays(today, -OVERDUE_DAYS);
  const from = profile.since ? (profile.since > yearBack ? profile.since : yearBack) : today;
  const dues = taxDues(settings, from < today ? from : today, addDays(today, TAX_DUE_WINDOW_DAYS));
  if (dues.length === 0) return [];
  // The entities the reader sees, and the marks they made for these periods.
  const entities = await ctx.trx
    .selectFrom('crove_kernel.legal_entity')
    .select(['id', 'name', 'is_default', 'created_at'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('is_default', 'desc')
    .orderBy('name')
    .execute();
  if (entities.length === 0) return [];
  const done = await ctx.trx
    .selectFrom('crove_kernel.tax_obligation_done')
    .select(['obligation', 'period', 'legal_entity_id'])
    .where('org_id', '=', ctx.orgId)
    .where('period', 'in', [...new Set(dues.map((d) => d.period))])
    .execute();
  const marks = new Map<string, Set<string>>();
  for (const m of done) marks.set(`${m.obligation}:${m.period}`, (marks.get(`${m.obligation}:${m.period}`) ?? new Set()).add(m.legal_entity_id));
  // Who must mark an obligation for the org to be done with it: the default entity, which stands for the org however old
  // its row is, and every other entity that existed by the end of the period, so an entity added later does not reopen
  // periods before it. Each entity files its own VAT return since finance marks it per entity (#1531).
  const owing = (d: (typeof dues)[number]) => entities.filter((e) => e.is_default || vietnamDay(new Date(e.created_at)) <= d.periodEnd);
  const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const mayMark = await markRule(ctx);
  return dues
    .map((d) => {
      const marked = marks.get(`${d.obligation}:${d.period}`);
      return { due: d, open: owing(d).filter((e) => !marked?.has(e.id)) };
    })
    // Due while an entity that owes it has not marked it; with none owing, not the reader's.
    .filter(({ open }) => open.length > 0)
    .slice(0, MAX_DUES)
    .map(({ due: d, open }) => ({
      obligation: d.obligation,
      period: d.period,
      dueDate: d.dueDate,
      daysLeft: Math.round((day(d.dueDate) - day(today)) / DAY_MS),
      legalBasis: d.legalBasis,
      confirmed: d.confirmed,
      // The entities the reader sees that still owe it (#1553), the default entity first, and whether the reader may mark
      // each done (#1917).
      openEntities: open.map((e) => ({ id: e.id, name: e.name, canMark: mayMark(d.obligation, e.id) })),
    }));
}

export const taxProfileGet = defineQuery({
  name: 'kernel.tax_profile.get',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<StoredTaxProfile> => readTaxProfile(ctx),
});

export const taxProfileSave = defineCommand({
  name: 'kernel.tax_profile.save',
  input: zTaxProfile,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input): Promise<StoredTaxProfile> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    if (input.obligations.includes('pit_withholding') && input.pitFilingPeriod === null) {
      throw new DomainError('PIT_FILING_PERIOD_REQUIRED', 422, 'Hãy chọn kỳ khai thuế TNCN khấu trừ (tháng hoặc quý)');
    }
    const obligations = TAX_OBLIGATIONS.filter((o) => (input.obligations as readonly string[]).includes(o)) as TaxProfile['obligations'];
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_kernel.tax_profile:${ctx.orgId}`}))`.execute(ctx.trx);
    const before = await readTaxProfile(ctx);
    const values = { obligations, pit_filing_period: input.pitFilingPeriod, fiscal_year_end_month: input.fiscalYearEndMonth, updated_by: ctx.actor.userId, updated_at: ctx.now };
    const updated = await ctx.trx.updateTable('crove_kernel.tax_profile').set(values).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      await ctx.trx.insertInto('crove_kernel.tax_profile').values({ org_id: ctx.orgId, ...values, created_at: ctx.now }).execute();
    }
    const { since: _since, ...previous } = before;
    ctx.audit({ previous, profile: { obligations, pitFilingPeriod: input.pitFilingPeriod, fiscalYearEndMonth: input.fiscalYearEndMonth } });
    await ctx.activity('kernel.tenant', ctx.orgId, 'org.tax_profile_saved', 'Cập nhật lịch thuế');
    return readTaxProfile(ctx);
  },
});

// The legal entity a mark is for: the one named, checked against the caller's scope (crove_kernel.legal_entity is read
// through le_scope, so an entity outside it is not found), or the org's default entity as the caller sees it.
async function markEntity(ctx: Pick<QueryContext, 'trx' | 'orgId'>, legalEntityId: string | undefined): Promise<string> {
  let q = ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId);
  q = legalEntityId === undefined ? q.where('is_default', '=', true) : q.where('id', '=', legalEntityId);
  const row = await q.executeTakeFirst();
  if (!row) throw new DomainError('LEGAL_ENTITY_NOT_FOUND', 422, 'Không tìm thấy pháp nhân này trong tổ chức');
  return row.id;
}

// The mark rule in the commands too (#1917): a member who is not a filer cannot mark the VAT return through this command
// either, however it is reached (rpc.ts sends the VAT return to finance.vat.return_mark, which runs this one as the
// same user once it has checked the same right).
async function assertMayMark(ctx: Pick<QueryContext, 'trx' | 'actor' | 'role' | 'installed'>, obligation: TaxObligation, legalEntityId: string): Promise<void> {
  if (!(await markRule(ctx))(obligation, legalEntityId)) {
    throw new DomainError('FORBIDDEN', 403, `Bạn không có quyền đánh dấu ${TAX_OBLIGATION_LABELS[obligation]} cho pháp nhân này`);
  }
}

// The frequency a period key names: "2026" a year, "2026-09" a month, "2026-Q3" a quarter.
function frequencyOf(period: string): 'year' | 'month' | 'quarter' {
  return period.length === 4 ? 'year' : period.includes('Q') ? 'quarter' : 'month';
}

export const taxObligationDone = defineCommand({
  name: 'kernel.tax_obligation.done',
  input: zTaxObligationMark,
  risk: 'R1',
  sideEffect: 'internal',
  access: MARKERS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    // A period of the obligation's own frequency: a monthly return is not marked done for a quarter.
    if (!TAX_RULES.some((r) => r.obligation === input.obligation && r.frequency === frequencyOf(input.period))) {
      throw new DomainError('TAX_PERIOD_MISMATCH', 422, `${TAX_OBLIGATION_LABELS[input.obligation]} không có kỳ ${input.period}`);
    }
    const legalEntityId = await markEntity(ctx, input.legalEntityId);
    await assertMayMark(ctx, input.obligation, legalEntityId);
    const inserted = await ctx.trx
      .insertInto('crove_kernel.tax_obligation_done')
      .values({ org_id: ctx.orgId, legal_entity_id: legalEntityId, obligation: input.obligation, period: input.period, done_by: ctx.actor.userId })
      .onConflict((oc) => oc.columns(['org_id', 'legal_entity_id', 'obligation', 'period']).doNothing())
      .returning('id')
      .executeTakeFirst();
    ctx.audit({ obligation: input.obligation, period: input.period, legalEntityId, already: inserted === undefined });
    // One entity's obligation: its row is read only where that entity is (#1725).
    if (inserted) {
      await ctx.activity('kernel.tenant', ctx.orgId, 'org.tax_obligation_done', `Đã xong: ${TAX_OBLIGATION_LABELS[input.obligation]} kỳ ${input.period}`, { legalEntityId });
    }
    return { obligation: input.obligation, period: input.period, legalEntityId, done: true as const };
  },
});

export const taxObligationUndo = defineCommand({
  name: 'kernel.tax_obligation.undo',
  input: zTaxObligationMark,
  risk: 'R1',
  sideEffect: 'internal',
  access: MARKERS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const legalEntityId = await markEntity(ctx, input.legalEntityId);
    await assertMayMark(ctx, input.obligation, legalEntityId);
    const removed = await ctx.trx
      .deleteFrom('crove_kernel.tax_obligation_done')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('obligation', '=', input.obligation)
      .where('period', '=', input.period)
      .executeTakeFirst();
    const found = Number(removed.numDeletedRows) > 0;
    ctx.audit({ obligation: input.obligation, period: input.period, legalEntityId, found });
    if (found) {
      await ctx.activity('kernel.tenant', ctx.orgId, 'org.tax_obligation_undone', `Bỏ đánh dấu đã xong: ${TAX_OBLIGATION_LABELS[input.obligation]} kỳ ${input.period}`, {
        legalEntityId,
      });
    }
    return { obligation: input.obligation, period: input.period, legalEntityId, done: false as const };
  },
});

export const taxCalendarCommands = [taxProfileSave, taxObligationDone, taxObligationUndo];
export const taxCalendarQueries = [taxProfileGet];
