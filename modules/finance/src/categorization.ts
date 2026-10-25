// Learned per-line account rules (issue #1399, plan §8.6 "Memory": learned deterministic rules stored as rows with
// provenance, applied before the LLM). A rule maps an invoice line to the account it is posted to, by the line's whole
// item description (normalized) or by a keyword in it, for one vendor or for every vendor.
// - Learning: when a purchase invoice is approved (finance.purchase.record), every line whose account a user chose on
//   the approved revision (finance.purchase.revise marks it) writes or updates the vendor's description rule, with the
//   approver, the time and the new document as provenance, in the same audited command.
// - Suggesting: extraction reads the vendor's rules and every vendor's rules (rulesForSuggestion) and @crove/l10n-vn
//   (suggestDebitAccount) applies them in order: the vendor's own rules, the vendor's default account, every vendor's
//   rules, then the built-in keyword list. A rule only proposes an account: the approver confirms every line and the
//   posting checks the account again.
// - Settings: every role lists the rules; owners and admins add a keyword rule and remove any rule (R1, audited).
// Matching is plain string comparison on normalized text (normalizeRuleText): no pattern from user input is compiled,
// and the lookup reads at most LEARNED_RULE_LIMIT rules of each scope.
import { sql } from 'kysely';
import { z } from 'zod';
import { isRevenueAccount, zAccountCode, zId, type CategorizationRule } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { descriptionRuleText, keywordRuleText, money, type LearnedRule, type ProposedLine } from '@crove/l10n-vn';
import { assertUsableAccounts } from './accounts.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
// The most rules of one scope (the vendor's own, or every vendor's) a suggestion reads, newest first.
export const LEARNED_RULE_LIMIT = 500;
// The most rules the Settings list shows, newest first.
export const RULE_LIST_LIMIT = 500;
// The reason finance.purchase.revise gave a line a user picked before #1399 marked it with accountRule.
const USER_CHOSEN_REASON = 'Người dùng chọn';

// The rules a suggestion reads for an invoice of `partyId` (null: a vendor not yet in the books): the vendor's own and
// every vendor's, each newest first, skipping a rule whose sub-account was deactivated since.
export async function rulesForSuggestion(ctx: QueryContext, partyId: string | null): Promise<LearnedRule[]> {
  const load = async (vendor: boolean) => {
    if (vendor && partyId === null) return [];
    const rows = await ctx.trx
      .selectFrom('crove_finance.categorization_rule as r')
      .select(['r.id', 'r.match_kind', 'r.match_text', 'r.label', 'r.debit_account'])
      .where('r.org_id', '=', ctx.orgId)
      .where((eb) => (vendor && partyId !== null ? eb('r.vendor_party_id', '=', partyId) : eb('r.vendor_party_id', 'is', null)))
      .where(({ or, exists, selectFrom }) =>
        or([
          exists(selectFrom('crove_finance.account as a').select('a.code').whereRef('a.code', '=', 'r.debit_account')),
          exists(
            selectFrom('crove_finance.org_account as o')
              .select('o.code')
              .whereRef('o.org_id', '=', 'r.org_id')
              .whereRef('o.code', '=', 'r.debit_account')
              .where('o.active', '=', true),
          ),
        ]),
      )
      .orderBy('r.confirmed_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(LEARNED_RULE_LIMIT)
      .execute();
    return rows.map((r) => ({ id: r.id, vendor, kind: r.match_kind, text: r.match_text, label: r.label, account: r.debit_account }));
  };
  return [...(await load(true)), ...(await load(false))];
}

// The lines of an approved purchase whose account a user chose: marked by finance.purchase.revise, or, on a revision
// made before #1399, by its reason.
export function userChosenLines<L extends Pick<ProposedLine, 'reason' | 'accountRule'>>(lines: readonly L[]): L[] {
  return lines.filter((l) => l.accountRule?.source === 'user' || (l.accountRule === undefined && l.reason === USER_CHOSEN_REASON));
}

// Writes or updates the vendor's description rule for every line whose account a user chose (#1399), inside
// finance.purchase.record. Lines with the same item text teach one rule: the line with the largest amount (either sign)
// decides, the first line on a tie. Written in text order, so two approvals for one vendor take the rows' locks in the
// same order. Only a user's approval teaches; returns what it wrote, for the audit row.
export async function learnFromApproval(
  ctx: CommandContext,
  input: { partyId: string; documentId: string; lines: ReadonlyArray<Pick<ProposedLine, 'lineNo' | 'description' | 'amount' | 'debitAccount' | 'reason' | 'accountRule'>> },
): Promise<Array<{ ruleId: string; lineNo: number; account: string; created: boolean }>> {
  if (ctx.actor.type !== 'user') return [];
  const byText = new Map<string, (typeof input.lines)[number]>();
  for (const line of userChosenLines(input.lines)) {
    const text = descriptionRuleText(line.description);
    if (text === null) continue;
    const kept = byText.get(text);
    if (!kept || money(line.amount).abs().greaterThan(money(kept.amount).abs())) byText.set(text, line);
  }
  const learned: Array<{ ruleId: string; lineNo: number; account: string; created: boolean }> = [];
  for (const [text, line] of [...byText.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const provenance = {
      label: line.description.trim().slice(0, 500),
      debit_account: line.debitAccount,
      confirmed_by: ctx.actor.userId,
      confirmed_at: ctx.now,
      source_document_id: input.documentId,
    };
    const row = await ctx.trx
      .insertInto('crove_finance.categorization_rule')
      .values({ org_id: ctx.orgId, vendor_party_id: input.partyId, match_kind: 'description', match_text: text, ...provenance })
      .onConflict((oc) => oc.constraint('categorization_rule_match_uq').doUpdateSet(provenance))
      .returning(['id', sql<boolean>`(xmax = 0)`.as('created')])
      .executeTakeFirstOrThrow();
    learned.push({ ruleId: row.id, lineNo: line.lineNo, account: line.debitAccount, created: row.created });
  }
  return learned;
}

export const categorizationRulesList = defineQuery({
  name: 'finance.categorization_rules.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<CategorizationRule[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.categorization_rule as r')
      .leftJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'r.org_id').onRef('p.id', '=', 'r.vendor_party_id'))
      .leftJoin('crove_finance.purchase_document as d', (join) => join.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.source_document_id'))
      .select([
        'r.id',
        'r.vendor_party_id',
        'p.name as vendor_name',
        'r.match_kind',
        'r.match_text',
        'r.label',
        'r.debit_account',
        'r.confirmed_by',
        'r.confirmed_at',
        'r.source_document_id',
        'd.invoice_series',
        'd.invoice_number',
        'd.invoice_date',
      ])
      .where('r.org_id', '=', ctx.orgId)
      .orderBy('r.confirmed_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(RULE_LIST_LIMIT)
      .execute();
    // Who confirmed a rule, by name while they are a member (crove_kernel.member_profiles answers only members).
    const users = [...new Set(rows.map((r) => r.confirmed_by).filter((u): u is string => u !== null))];
    const names = new Map<string, string>();
    if (users.length > 0) {
      const { rows: people } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${users}::uuid[])`.execute(ctx.trx);
      for (const p of people) names.set(p.user_id, p.display_name ?? p.email);
    }
    return rows.map((r) => ({
      id: r.id,
      vendor: r.vendor_party_id ? { partyId: r.vendor_party_id, name: r.vendor_name ?? '' } : null,
      matchKind: r.match_kind,
      matchText: r.match_text,
      label: r.label,
      accountCode: r.debit_account,
      confirmedBy: r.confirmed_by ? (names.get(r.confirmed_by) ?? null) : null,
      confirmedAt: r.confirmed_at.toISOString(),
      sourceDocument:
        r.source_document_id && r.invoice_number !== null && r.invoice_date !== null
          ? { documentId: r.source_document_id, series: r.invoice_series ?? '', number: r.invoice_number, invoiceDate: r.invoice_date }
          : null,
    }));
  },
});

export const createCategorizationRule = defineCommand({
  name: 'finance.categorization_rule.create',
  input: z.object({
    keyword: z.string().trim().min(1).max(500),
    accountCode: zAccountCode,
    // Omitted or null: the rule applies to every vendor.
    vendorPartyId: zId.nullable().optional(),
  }),
  risk: 'R1',
  access: MANAGERS,
  handler: async (ctx, input) => {
    const text = keywordRuleText(input.keyword);
    if (text === null) {
      throw new DomainError('RULE_TEXT_TOO_SHORT', 422, 'Từ khóa cần có ít nhất hai chữ cái hoặc chữ số');
    }
    // A learned rule proposes the account of a purchase line, which never goes to a revenue account (#430).
    if (isRevenueAccount(input.accountCode)) {
      throw new DomainError('REVENUE_ACCOUNT_ON_PURCHASE', 422, `Quy tắc dùng cho hàng hóa, dịch vụ mua vào nên không chọn tài khoản doanh thu ${input.accountCode}`, {
        account: input.accountCode,
      });
    }
    await assertUsableAccounts(ctx, [input.accountCode]);
    const vendorPartyId = input.vendorPartyId ?? null;
    if (vendorPartyId !== null) {
      const party = await ctx.trx.selectFrom('crove_kernel.party').select('id').where('org_id', '=', ctx.orgId).where('id', '=', vendorPartyId).executeTakeFirst();
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy nhà cung cấp');
    }
    const row = await ctx.trx
      .insertInto('crove_finance.categorization_rule')
      .values({
        org_id: ctx.orgId,
        vendor_party_id: vendorPartyId,
        match_kind: 'keyword',
        match_text: text,
        label: input.keyword.slice(0, 500),
        debit_account: input.accountCode,
        confirmed_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        confirmed_at: ctx.now,
      })
      .onConflict((oc) => oc.constraint('categorization_rule_match_uq').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new DomainError('RULE_EXISTS', 409, `Đã có quy tắc cho từ khóa "${input.keyword}"; hãy xóa quy tắc cũ trước nếu muốn đổi tài khoản`);
    ctx.audit({ ruleId: row.id, matchKind: 'keyword', matchText: text, accountCode: input.accountCode, vendorPartyId });
    return { id: row.id };
  },
});

export const removeCategorizationRule = defineCommand({
  name: 'finance.categorization_rule.remove',
  input: z.object({ id: zId }),
  risk: 'R1',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.categorization_rule', id: input.id }),
  handler: async (ctx, { id }) => {
    const removed = await ctx.trx
      .deleteFrom('crove_finance.categorization_rule')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', id)
      .returning(['vendor_party_id', 'match_kind', 'match_text', 'debit_account', 'confirmed_by', 'source_document_id'])
      .executeTakeFirst();
    if (!removed) throw new DomainError('RULE_NOT_FOUND', 404, 'Không tìm thấy quy tắc này; có thể đã có người xóa');
    // The audit row keeps what the rule said and where it came from.
    ctx.audit({
      ruleId: id,
      vendorPartyId: removed.vendor_party_id,
      matchKind: removed.match_kind,
      matchText: removed.match_text,
      accountCode: removed.debit_account,
      confirmedBy: removed.confirmed_by,
      sourceDocumentId: removed.source_document_id,
    });
    return { id };
  },
});

export const categorizationCommands = [createCategorizationRule, removeCategorizationRule];
export const categorizationQueries = [categorizationRulesList];
