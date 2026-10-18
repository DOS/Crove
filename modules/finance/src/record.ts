// finance.purchase.record: turns an approved invoice proposal into a party, a document and a balanced TT133 journal
// entry. Runs only through kernel.proposal.approve, on the stored revision as is. A purchase (the org bought) records
// the seller as the vendor and posts Dr expense or asset, Dr 1331/1332, Cr 331. A sale (direction 'sale', issue #313:
// the org issued the invoice) records the buyer as the customer and posts Dr 131, Cr revenue, Cr 3331.
// finance.purchase.revise: computes the payload of a new revision when a user edits a pending proposal
// (kernel.proposal.edit); it writes nothing.
import { z } from 'zod';
import { BLOCKING_CHECK_IDS, zAccountCode, zPurchaseProposal, type DocumentDirection, type PurchaseProposal } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import {
  PAYABLE_ACCOUNT,
  RECEIVABLE_ACCOUNT,
  buildPurchaseJournal,
  buildSalesJournal,
  journalIsBalanced,
  money,
  parseTaxCode,
  type JournalLineDraft,
  type ProposedLine,
} from '@crove/l10n-vn';
import { assertUsableAccounts } from './accounts.ts';
import { postJournalEntry } from './ledger.ts';
import { journalMemo } from './memo.ts';

function directionOf(payload: PurchaseProposal): DocumentDirection {
  return payload.direction ?? 'purchase';
}

// The journal of an invoice by its direction.
export function invoiceJournal(direction: DocumentDirection, lines: ProposedLine[], vatTotal: string, memo: string): JournalLineDraft[] {
  return direction === 'sale' ? buildSalesJournal(lines, vatTotal, memo) : buildPurchaseJournal(lines, vatTotal, memo);
}

// The party of the invoice in Crove's books: the supplier of a purchase, the customer of a sale. Matched by tax code,
// or by name when the invoice gives none.
async function upsertParty(ctx: CommandContext, ref: PurchaseProposal['seller'], direction: DocumentDirection): Promise<string> {
  const taxCode = parseTaxCode(ref.taxCode)?.normalized ?? null;
  const name = ref.name.trim() || (direction === 'sale' ? 'Khách hàng chưa rõ tên' : 'Nhà cung cấp chưa rõ tên');
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
      address: ref.address,
      email: ref.email,
      phone: ref.phone,
      source_trust: 'external',
      verified_at: ctx.now,
      verified_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await ctx.activity('kernel.party', created.id, 'party.created', direction === 'sale' ? `Thêm khách hàng ${name}` : `Thêm nhà cung cấp ${name}`);
  return created.id;
}

// The voided document of this invoice that no later document has replaced yet, or null. There is at most one: every
// document of an invoice but the first replaces a voided one, each at most once. The same invoice is the same supplier,
// series and number for a purchase, and the same series and number for a sale (the org numbers its own invoices).
async function replaceableDocument(ctx: CommandContext, direction: DocumentDirection, partyId: string, series: string, number: string): Promise<string | null> {
  let query = ctx.trx
    .selectFrom('crove_finance.purchase_document as d')
    .innerJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
    .select('d.id')
    .where('d.org_id', '=', ctx.orgId)
    .where('d.direction', '=', direction)
    .where('d.invoice_series', '=', series)
    .where('d.invoice_number', '=', number)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('crove_finance.purchase_document as n')
            .select('n.id')
            .whereRef('n.org_id', '=', 'd.org_id')
            .whereRef('n.replaces_document_id', '=', 'd.id'),
        ),
      ),
    );
  if (direction === 'purchase') query = query.where('d.party_id', '=', partyId);
  const row = await query.limit(1).executeTakeFirst();
  return row?.id ?? null;
}

// A sale must be the org's own invoice, and a purchase must not be: the org's tax code (kernel.org.set_tax_code) is
// read again here, so a proposal raised before it was set or changed cannot book an invoice on the wrong side. The
// tenant row is read FOR SHARE until commit, so a concurrent kernel.org.set_tax_code waits for this posting.
async function assertDirection(ctx: CommandContext, payload: PurchaseProposal): Promise<void> {
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).forShare().executeTakeFirst();
  const orgTaxCode = org?.tax_code ?? null;
  const sellerTaxCode = parseTaxCode(payload.seller.taxCode)?.normalized ?? null;
  const ownInvoice = orgTaxCode !== null && sellerTaxCode === orgTaxCode;
  if (directionOf(payload) === 'sale' && !ownInvoice) {
    throw new DomainError('NOT_OWN_SALE', 422, 'Mã số thuế người bán không phải mã số thuế của tổ chức nên không ghi sổ như hóa đơn bán ra được; hãy kiểm tra mã số thuế trong Cài đặt rồi đọc lại tệp');
  }
  if (directionOf(payload) === 'purchase' && ownInvoice) {
    throw new DomainError('OWN_INVOICE', 422, 'Người bán là chính tổ chức nên đây là hóa đơn bán ra; hãy đọc lại tệp để ghi sổ như hóa đơn bán ra');
  }
}

export const revisePurchase = defineCommand({
  name: 'finance.purchase.revise',
  input: z.object({
    payload: zPurchaseProposal,
    // debitAccount: the account a line is posted to (a revenue account on a sale line; see zProposedLine).
    lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).min(1).max(1000),
  }),
  risk: 'R1',
  access: 'proposal_revision',
  revises: 'finance.purchase.record',
  handler: async (ctx, { payload, lineAccounts }) => {
    const lineNos = new Set(payload.lines.map((l) => l.lineNo));
    if (lineAccounts.some((l) => !lineNos.has(l.lineNo))) throw new DomainError('UNKNOWN_LINE', 422, 'Có dòng không thuộc hóa đơn này');
    const overrides = new Map(lineAccounts.map((l) => [l.lineNo, l.debitAccount]));
    const chosen: string[] = [];
    const lines = payload.lines.map((l) => {
      const account = overrides.get(l.lineNo);
      if (!account || account === l.debitAccount) return l;
      chosen.push(account);
      return { ...l, debitAccount: account, reason: 'Người dùng chọn' };
    });
    if (chosen.length === 0) return { changed: false as const, payload };
    // The accounts the user picked now; the others are checked again when the proposal is approved.
    await assertUsableAccounts(ctx, chosen);
    const revised = { ...payload, lines, journal: invoiceJournal(directionOf(payload), lines, payload.invoice.vatTotal, journalMemo(payload)) };
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
    const direction = directionOf(payload);
    const sale = direction === 'sale';
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
    await assertDirection(ctx, payload);
    // Line accounts come from the approved revision; changing them is an edit (kernel.proposal.edit). A sub-account
    // deactivated since the proposal was made is refused here, with its code.
    const { lines } = payload;
    await assertUsableAccounts(ctx, lines.map((l) => l.debitAccount));

    const memo = journalMemo(payload);
    const journal = invoiceJournal(direction, lines, invoice.vatTotal, memo);
    if (!journalIsBalanced(journal)) throw new DomainError('UNBALANCED', 422, 'Bút toán không cân');
    // The payable (purchase) or receivable (sale) booked must equal the invoice total exactly.
    const counterAccount = sale ? RECEIVABLE_ACCOUNT : PAYABLE_ACCOUNT;
    const booked = journal
      .filter((j) => j.accountCode === counterAccount)
      .reduce((acc, j) => (sale ? acc.plus(money(j.debit)).minus(money(j.credit)) : acc.plus(money(j.credit)).minus(money(j.debit))), money(0));
    if (!booked.equals(money(invoice.total))) {
      throw new DomainError('TOTAL_MISMATCH', 422, 'Tổng các dòng và thuế không khớp tổng thanh toán của hóa đơn');
    }

    const partyId = await upsertParty(ctx, sale ? payload.buyer : payload.seller, direction);
    // The invoice recorded again after its document was voided by a reversal (#165): the new document names the
    // voided one it replaces. Any other document of the same invoice still in force makes this a duplicate, refused
    // by the database (purchase_document_purchase_invoice_uq, purchase_document_sale_invoice_uq,
    // purchase_document_replaces_uq).
    const replaces = await replaceableDocument(ctx, direction, partyId, invoice.series, invoice.number);
    const document = await ctx.trx
      .insertInto('crove_finance.purchase_document')
      .values({
        org_id: ctx.orgId,
        direction,
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
        replaces_document_id: replaces,
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
          // A purchase line is debited to its account, a sale line credited to it.
          debit_account: sale ? null : l.debitAccount,
          credit_account: sale ? l.debitAccount : null,
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
        partyId: j.accountCode === counterAccount ? partyId : null,
        memo: j.memo,
      })),
    });

    // Remember the debit account carrying the largest amount (either sign) for this vendor. Sales remember nothing.
    const main = sale ? undefined : [...lines].sort((a, b) => money(b.amount).abs().comparedTo(money(a.amount).abs()))[0];
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
        .execute()
        .catch((error: { code?: string }) => {
          // The sub-account was deactivated after the check above (the database checks it again under a lock).
          if (error?.code === '23503') throw new DomainError('ACCOUNT_INACTIVE', 422, `Tài khoản ${main.debitAccount} đã ngừng sử dụng; hãy chọn tài khoản khác`);
          throw error;
        });
    }

    ctx.audit({ direction, ...(replaces ? { replaces_document_id: replaces } : {}) });
    const event = sale ? 'sale.recorded' : 'purchase.recorded';
    await ctx.activity('finance.purchase_document', document.id, event, replaces ? `Ghi sổ lại ${memo} (thay chứng từ đã hủy)` : `Ghi sổ ${memo}`);
    await ctx.emit('finance.purchase.recorded', { documentId: document.id, journalEntryId, direction, ...(replaces ? { replacesDocumentId: replaces } : {}) });
    return { documentId: document.id, journalEntryId };
  },
});
