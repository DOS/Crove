// finance.purchase.record: turns an approved purchase proposal into a vendor, a purchase document
// and a balanced TT133 journal entry. Runs only through kernel.proposal.approve, on the stored revision as is.
// finance.purchase.revise: computes the payload of a new revision when a user edits a pending proposal
// (kernel.proposal.edit); it writes nothing.
import { z } from 'zod';
import { BLOCKING_CHECK_IDS, zAccountCode, zPurchaseProposal } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { buildPurchaseJournal, journalIsBalanced, money, parseTaxCode } from '@crove/l10n-vn';
import { postJournalEntry } from './ledger.ts';

async function upsertVendor(ctx: CommandContext, seller: z.infer<typeof zPurchaseProposal>['seller']): Promise<string> {
  const taxCode = parseTaxCode(seller.taxCode)?.normalized ?? null;
  const name = seller.name.trim() || 'Nhà cung cấp chưa rõ tên';
  const existing = taxCode
    ? await ctx.trx
        .selectFrom('crove_kernel.party')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('tax_code', '=', taxCode)
        .executeTakeFirst()
    : await ctx.trx
        .selectFrom('crove_kernel.party')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('tax_code', 'is', null)
        .where((eb) => eb(eb.fn('lower', ['name']), '=', name.toLowerCase()))
        .executeTakeFirst();
  if (existing) return existing.id;
  const created = await ctx.trx
    .insertInto('crove_kernel.party')
    .values({
      org_id: ctx.orgId,
      name,
      tax_code: taxCode,
      address: seller.address,
      email: seller.email,
      phone: seller.phone,
      source_trust: 'external',
      verified_at: ctx.now,
      verified_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await ctx.activity('kernel.party', created.id, 'party.created', `Thêm nhà cung cấp ${name}`);
  return created.id;
}

function journalMemo(payload: z.infer<typeof zPurchaseProposal>): string {
  const { invoice } = payload;
  return `HĐ ${invoice.series ? `${invoice.series}-` : ''}${invoice.number} ${payload.seller.name}`.trim();
}

async function assertKnownAccounts(ctx: CommandContext, codes: string[]): Promise<void> {
  const unique = [...new Set(codes)];
  const known = await ctx.trx.selectFrom('crove_finance.account').select('code').where('code', 'in', unique).execute();
  if (known.length !== unique.length) throw new DomainError('UNKNOWN_ACCOUNT', 422, 'Có tài khoản không thuộc hệ thống TT133');
}

export const revisePurchase = defineCommand({
  name: 'finance.purchase.revise',
  input: z.object({
    payload: zPurchaseProposal,
    lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).min(1).max(1000),
  }),
  risk: 'R1',
  access: 'proposal_revision',
  revises: 'finance.purchase.record',
  handler: async (ctx, { payload, lineAccounts }) => {
    const lineNos = new Set(payload.lines.map((l) => l.lineNo));
    if (lineAccounts.some((l) => !lineNos.has(l.lineNo))) throw new DomainError('UNKNOWN_LINE', 422, 'Có dòng không thuộc hóa đơn này');
    const overrides = new Map(lineAccounts.map((l) => [l.lineNo, l.debitAccount]));
    let changed = false;
    const lines = payload.lines.map((l) => {
      const account = overrides.get(l.lineNo);
      if (!account || account === l.debitAccount) return l;
      changed = true;
      return { ...l, debitAccount: account, reason: 'Người dùng chọn' };
    });
    if (!changed) return { changed: false as const, payload };
    await assertKnownAccounts(ctx, lines.map((l) => l.debitAccount));
    const revised = { ...payload, lines, journal: buildPurchaseJournal(lines, payload.invoice.vatTotal, journalMemo(payload)) };
    return { changed: true as const, payload: revised };
  },
});

export const recordPurchase = defineCommand({
  name: 'finance.purchase.record',
  input: z.object({
    payload: zPurchaseProposal,
    acceptFailedChecks: z.boolean().default(false),
  }),
  risk: 'R3',
  access: 'proposal',
  handler: async (ctx, { payload, acceptFailedChecks }) => {
    const { invoice } = payload;
    // The checks shown in the Inbox are enforced here, not only in the UI.
    if (invoice.currency.toUpperCase() !== 'VND') {
      throw new DomainError('UNSUPPORTED_CURRENCY', 422, 'Chưa hỗ trợ ghi sổ hóa đơn ngoại tệ');
    }
    const failed = payload.checks.filter((c) => c.status === 'fail');
    if (failed.some((c) => BLOCKING_CHECK_IDS.includes(c.id))) {
      throw new DomainError('CHECKS_BLOCKING', 422, 'Số tiền trên hóa đơn không khớp nhau nên không ghi sổ được; hãy từ chối và xin hóa đơn điều chỉnh');
    }
    if (failed.length > 0 && !acceptFailedChecks) {
      throw new DomainError('CHECKS_FAILED', 422, `Còn ${failed.length} kiểm tra không đạt; hãy xác nhận đã đối chiếu chứng từ gốc`);
    }
    // Line accounts come from the approved revision; changing them is an edit (kernel.proposal.edit).
    const { lines } = payload;
    await assertKnownAccounts(ctx, lines.map((l) => l.debitAccount));

    const memo = journalMemo(payload);
    const journal = buildPurchaseJournal(lines, invoice.vatTotal, memo);
    if (!journalIsBalanced(journal)) throw new DomainError('UNBALANCED', 422, 'Bút toán không cân');
    // The payable booked must equal the invoice total exactly.
    const payable = journal.filter((j) => j.accountCode === '331').reduce((acc, j) => acc.plus(money(j.credit)).minus(money(j.debit)), money(0));
    if (!payable.equals(money(invoice.total))) {
      throw new DomainError('TOTAL_MISMATCH', 422, 'Tổng các dòng và thuế không khớp tổng thanh toán của hóa đơn');
    }

    const partyId = await upsertVendor(ctx, payload.seller);
    const document = await ctx.trx
      .insertInto('crove_finance.purchase_document')
      .values({
        org_id: ctx.orgId,
        party_id: partyId,
        invoice_series: invoice.series,
        invoice_number: invoice.number,
        invoice_date: invoice.issueDate,
        currency: invoice.currency,
        subtotal: invoice.subtotal,
        vat_amount: invoice.vatTotal,
        total: invoice.total,
        payment_method: invoice.paymentMethod,
        tax_authority_code: invoice.taxAuthorityCode,
        source_file_id: payload.sourceFileId,
        proposal_id: ctx.proposalId,
        created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .returning('id')
      .executeTakeFirst()
      .catch((error: { code?: string }) => {
        if (error?.code === '23505') throw new DomainError('DUPLICATE_INVOICE', 409, 'Hóa đơn này đã được ghi sổ');
        throw error;
      });
    if (!document) throw new DomainError('INTERNAL', 500, 'Không ghi được chứng từ');

    await ctx.trx
      .insertInto('crove_finance.purchase_line')
      .values(
        lines.map((l) => ({
          org_id: ctx.orgId,
          document_id: document.id,
          line_no: l.lineNo,
          description: l.description,
          unit: l.unit,
          quantity: l.quantity,
          unit_price: l.unitPrice,
          amount: l.amount,
          vat_rate: l.vatRate,
          debit_account: l.debitAccount,
        })),
      )
      .execute();

    const journalEntryId = await postJournalEntry(ctx, {
      entryDate: invoice.issueDate,
      description: memo,
      sourceType: 'finance.purchase_document',
      sourceId: document.id,
      lines: journal.map((j) => ({
        lineNo: j.lineNo,
        accountCode: j.accountCode,
        debit: j.debit,
        credit: j.credit,
        partyId: j.accountCode === '331' ? partyId : null,
        memo: j.memo,
      })),
    });

    // Remember the debit account carrying the largest amount (either sign) for this vendor.
    const main = [...lines].sort((a, b) => money(b.amount).abs().comparedTo(money(a.amount).abs()))[0];
    if (main) {
      await ctx.trx
        .insertInto('crove_finance.vendor_account_rule')
        .values({
          org_id: ctx.orgId,
          party_id: partyId,
          debit_account: main.debitAccount,
          confirmed_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'party_id']).doUpdateSet({
            debit_account: main.debitAccount,
            confirmed_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
            updated_at: ctx.now,
          }),
        )
        .execute();
    }

    await ctx.activity('finance.purchase_document', document.id, 'purchase.recorded', `Ghi sổ ${memo}`);
    await ctx.emit('finance.purchase.recorded', { documentId: document.id, journalEntryId });
    return { documentId: document.id, journalEntryId };
  },
});
