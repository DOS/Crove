// finance.purchase.record: turns an approved invoice proposal into a party, a document and a balanced TT133 journal
// entry. Runs only through kernel.proposal.approve, on the stored revision as is. A purchase (the org bought) records
// the seller as the vendor and posts Dr expense or asset, Dr 1331/1332, Cr 331. A sale (direction 'sale', issue #313:
// the org issued the invoice) records the buyer as the customer and posts Dr 131, Cr revenue, Cr 3331.
// A purchase invoice dated in a locked month (#478), or on or before the org's opening entry (#366), may be posted
// later: the approver picks a later posting date (kernel.proposal.approve postingDate). The document keeps the invoice
// date, the journal entry is dated on the posting date, and the VAT working declares the invoice in the period of that
// date (vat.ts).
// finance.purchase.revise: computes the payload of a new revision when a user edits a pending proposal
// (kernel.proposal.edit); it writes nothing.
import { sql } from 'kysely';
import { z } from 'zod';
import { BLOCKING_CHECK_IDS, isRevenueAccount, zAccountCode, zExchangeRate, zLocalDate, zPurchaseProposal, type DocumentDirection, type PurchaseProposal, type RelatedInvoiceRef } from '@crove/kernel-contract';
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
import { assertUsableAccounts, isInactiveDefaultRefusal } from './accounts.ts';
import { postJournalEntry } from './ledger.ts';
import { postReversal } from './reversal.ts';
import { journalMemo } from './memo.ts';
import { isOwnTaxCode } from './own-tax-code.ts';
import { databaseToday, dateLabel, liveOpeningDate } from './period-lock.ts';
import { BOOK_CURRENCY, checkRate, convertInvoice, foreignNote, toDong } from './domain/foreign-currency.ts';

function directionOf(payload: PurchaseProposal): DocumentDirection {
  return payload.direction ?? 'purchase';
}

// The journal of an invoice by its direction.
export function invoiceJournal(direction: DocumentDirection, lines: ProposedLine[], vatTotal: string, memo: string): JournalLineDraft[] {
  return direction === 'sale' ? buildSalesJournal(lines, vatTotal, memo) : buildPurchaseJournal(lines, vatTotal, memo);
}

// The party of the invoice in Crove's books: the supplier of a purchase, the customer of a sale. Matched by tax code,
// or by name when the invoice gives none. Opening balances per party (#689) find or create theirs the same way.
export async function upsertParty(ctx: CommandContext, ref: PurchaseProposal['seller'], direction: DocumentDirection): Promise<string> {
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

// The document of the invoice a replacement or an adjustment corrects (#916), read under a transaction-level advisory
// lock on that invoice, so two corrections of it approved at once take turns (documents are append-only, so their rows
// cannot be locked); a reversal of it asked for meanwhile still meets the one-reversal-per-entry index. It is the
// latest document of that invoice (same direction,
// same supplier for a purchase), with whether it is voided and its entry. A replacement links to it whether it is in
// force (this approval voids it) or already voided by a reversal and replaced by nothing yet; an adjustment links only
// to one in force. The database checks the link again (check_document_corrects).
async function correctedDocument(ctx: CommandContext, direction: DocumentDirection, partyId: string, related: RelatedInvoiceRef) {
  const key = `crove_finance.invoice_correction:${ctx.orgId}:${direction}:${direction === 'sale' ? '' : partyId}:${related.series}/${related.number}`;
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`.execute(ctx.trx);
  let query = ctx.trx
    .selectFrom('crove_finance.purchase_document as d')
    .select(['d.id', 'd.invoice_date'])
    .select((eb) => [
      eb
        .exists(eb.selectFrom('crove_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'))
        .as('voided'),
      eb
        .exists(
          eb
            .selectFrom('crove_finance.purchase_document as r')
            .select('r.id')
            .whereRef('r.org_id', '=', 'd.org_id')
            .whereRef('r.corrects_document_id', '=', 'd.id')
            .where('r.correction_kind', '=', 'replacement'),
        )
        .as('replaced'),
    ])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.direction', '=', direction)
    .where('d.invoice_series', '=', related.series)
    .where('d.invoice_number', '=', related.number);
  if (direction === 'purchase') query = query.where('d.party_id', '=', partyId);
  const document = await query.orderBy('d.created_at', 'desc').orderBy('d.id', 'desc').limit(1).executeTakeFirst();
  if (!document) return null;
  if (related.kind === 'adjustment') return document.voided ? null : { id: document.id, inForce: true };
  if (document.replaced) return null;
  return { id: document.id, inForce: !document.voided };
}

// The posted entry of a document in force, which a replacement reverses.
async function documentEntry(ctx: CommandContext, documentId: string) {
  const entry = await ctx.trx
    .selectFrom('crove_finance.journal_entry')
    .select(['id', 'entry_date', 'description', 'source_type', 'source_id'])
    .where('org_id', '=', ctx.orgId)
    .where('source_type', '=', 'finance.purchase_document')
    .where('source_id', '=', documentId)
    .where('reverses_entry_id', 'is', null)
    .executeTakeFirst();
  if (!entry) throw new DomainError('INTERNAL', 500, 'Không tìm thấy bút toán của hóa đơn gốc');
  return entry;
}

// A sale must be the org's own invoice, and a purchase must not be: the org's tax code (kernel.org.set_tax_code) is
// read again here, so a proposal raised before it was set or changed cannot book an invoice on the wrong side. The
// tenant row is read FOR SHARE until commit, so a concurrent kernel.org.set_tax_code waits for this posting.
async function assertDirection(ctx: CommandContext, payload: PurchaseProposal): Promise<void> {
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).forShare().executeTakeFirst();
  const orgTaxCode = org?.tax_code ?? null;
  // The org's branches (#686) issue its own invoices too.
  const ownInvoice = isOwnTaxCode(payload.seller.taxCode, orgTaxCode);
  if (directionOf(payload) === 'sale' && !ownInvoice) {
    throw new DomainError('NOT_OWN_SALE', 422, 'Mã số thuế người bán không phải mã số thuế của tổ chức nên không ghi sổ như hóa đơn bán ra được; hãy kiểm tra mã số thuế trong Cài đặt rồi đọc lại tệp');
  }
  if (directionOf(payload) === 'purchase' && ownInvoice) {
    throw new DomainError('OWN_INVOICE', 422, 'Người bán là chính tổ chức nên đây là hóa đơn bán ra; hãy đọc lại tệp để ghi sổ như hóa đơn bán ra');
  }
}

// A posting date other than the invoice date (#478), checked before anything is written: only for a purchase, never
// before the invoice date, never after today in Vietnam (`today` by the database clock, as lock_period() counts
// months). Whether the invoice's own date is closed (its month locked, or on or before the opening entry) is checked
// once the entry is posted (lateReason), under the lock the posting guard holds. The guard itself refuses a posting date
// inside the locked months or on or before the opening entry.
export function latePostingRefusal(direction: DocumentDirection, issueDate: string, postingDate: string, today: string): DomainError | null {
  if (direction === 'sale') {
    return new DomainError('POSTING_DATE_NOT_ALLOWED', 422, 'Hóa đơn bán ra ghi sổ theo ngày lập hóa đơn, không chọn được ngày ghi sổ khác', { postingDate });
  }
  if (postingDate < issueDate) {
    return new DomainError('POSTING_DATE_NOT_ALLOWED', 422, `Ngày ghi sổ không được trước ngày hóa đơn ${dateLabel(issueDate)}`, { postingDate, issueDate });
  }
  if (postingDate > today) {
    return new DomainError('POSTING_DATE_IN_FUTURE', 422, `Ngày ghi sổ ${dateLabel(postingDate)} chưa tới; hãy chọn một ngày từ hôm nay trở về trước`, { postingDate });
  }
  return null;
}

// Why the invoice may not post on its own date, so a later posting date is allowed: its month is locked (#478), or it is
// dated on or before the org's opening entry in force (#366). Otherwise the entry stays on the invoice date, as before
// #478. Read after the posting: the posted entry holds the org's period_lock row FOR SHARE until commit (the guard on
// journal_entry), and both a lock and an opening entry need it FOR UPDATE, so neither moves before this posting commits.
async function lateReason(ctx: CommandContext, issueDate: string, postingDate: string): Promise<'locked' | 'opening'> {
  const row = await ctx.trx.selectFrom('crove_finance.period_lock').select('locked_through').where('org_id', '=', ctx.orgId).executeTakeFirst();
  const lockedThrough = row?.locked_through ?? null;
  if (lockedThrough !== null && issueDate <= lockedThrough) return 'locked';
  const openingDate = await liveOpeningDate(ctx);
  if (openingDate !== null && issueDate <= openingDate) return 'opening';
  throw new DomainError(
    'POSTING_DATE_NOT_ALLOWED',
    422,
    `Tháng của hóa đơn ngày ${dateLabel(issueDate)} chưa khóa sổ và ngày đó sau ngày số dư đầu kỳ, nên bút toán ghi theo ngày hóa đơn; hãy duyệt mà không chọn ngày ghi sổ khác`,
    { postingDate, issueDate, lockedThrough, openingDate },
  );
}

// A sale line goes to a revenue account and a purchase line never does (#430, isRevenueAccount); the database holds
// every writer to the same rule (crove_finance.check_line_direction). Checked here first to name the line.
function assertDirectionAccounts(direction: DocumentDirection, lines: ReadonlyArray<Pick<ProposedLine, 'lineNo' | 'debitAccount'>>): void {
  for (const line of lines) {
    if (direction === 'sale' && !isRevenueAccount(line.debitAccount)) {
      throw new DomainError(
        'NOT_REVENUE_ACCOUNT',
        422,
        `Dòng ${line.lineNo} là doanh thu nên phải ghi vào tài khoản doanh thu (511, 515, 711, 3387 hoặc tài khoản con của chúng), không phải ${line.debitAccount}`,
        { lineNo: line.lineNo, account: line.debitAccount },
      );
    }
    if (direction === 'purchase' && isRevenueAccount(line.debitAccount)) {
      throw new DomainError(
        'REVENUE_ACCOUNT_ON_PURCHASE',
        422,
        `Dòng ${line.lineNo} là hàng hóa, dịch vụ mua vào nên không ghi vào tài khoản doanh thu ${line.debitAccount}; hãy chọn tài khoản chi phí, hàng hóa hoặc tài sản`,
        { lineNo: line.lineNo, account: line.debitAccount },
      );
    }
  }
}

export const revisePurchase = defineCommand({
  name: 'finance.purchase.revise',
  input: z.object({
    payload: zPurchaseProposal,
    // debitAccount: the account a line is posted to (a revenue account on a sale line; see zProposedLine).
    lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).max(1000),
    // The rate of a foreign-currency invoice read without one (#918): the proposal is converted to VND at it.
    exchangeRate: zExchangeRate.optional(),
  }),
  risk: 'R1',
  access: 'proposal_revision',
  revises: 'finance.purchase.record',
  handler: async (ctx, { payload: before, lineAccounts, exchangeRate }) => {
    const payload = exchangeRate ? withEnteredRate(before, exchangeRate) : before;
    const lineNos = new Set(payload.lines.map((l) => l.lineNo));
    if (lineAccounts.some((l) => !lineNos.has(l.lineNo))) throw new DomainError('UNKNOWN_LINE', 422, 'Có dòng không thuộc hóa đơn này');
    const overrides = new Map(lineAccounts.map((l) => [l.lineNo, l.debitAccount]));
    const chosen: Array<{ lineNo: number; debitAccount: string }> = [];
    const lines = payload.lines.map((l) => {
      const account = overrides.get(l.lineNo);
      if (!account || account === l.debitAccount) return l;
      chosen.push({ lineNo: l.lineNo, debitAccount: account });
      return { ...l, debitAccount: account, reason: 'Người dùng chọn' };
    });
    if (chosen.length === 0 && !exchangeRate) return { changed: false as const, payload };
    // The accounts the user picked now; the others are checked again when the proposal is approved.
    assertDirectionAccounts(directionOf(payload), chosen);
    await assertUsableAccounts(ctx, chosen.map((l) => l.debitAccount));
    const revised = { ...payload, lines, journal: invoiceJournal(directionOf(payload), lines, payload.invoice.vatTotal, journalMemo(payload)) };
    return { changed: true as const, payload: revised };
  },
});

// The currency check of a proposal converted at a rate a user entered (#918): a warning naming the rate.
export function enteredRateCheck(currency: string, rate: string) {
  return {
    id: 'currency',
    status: 'warn' as const,
    code: 'currency.rate_entered',
    params: { currency, rate },
    message: `Hóa đơn bằng ${currency}; ghi sổ bằng VND theo tỷ giá ${rate} do người dùng nhập`,
  };
}

// A foreign-currency proposal without a rate, converted to VND at the one the accountant entered (#918). Its failed
// currency check becomes a warning naming the rate, so the approver (never the person who entered it, P10) sees it.
function withEnteredRate(payload: PurchaseProposal, rate: string): PurchaseProposal {
  const currency = payload.invoice.currency.toUpperCase();
  if (currency === BOOK_CURRENCY || payload.invoice.foreign || !/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError('RATE_NOT_EDITABLE', 422, 'Chỉ nhập tỷ giá cho hóa đơn ngoại tệ chưa có tỷ giá');
  }
  type Line = PurchaseProposal['lines'][number];
  const { invoice, foreign } = convertInvoice<Line, PurchaseProposal['invoice'] & { lines: Line[] }>(
    { ...payload.invoice, lines: payload.lines },
    rate,
    (l) => l.amount,
    (l, amount) => ({ ...l, amount }),
  );
  const { lines, ...converted } = invoice;
  const check = enteredRateCheck(currency, foreign.rate);
  const checks = payload.checks.some((c) => c.id === 'currency') ? payload.checks.map((c) => (c.id === 'currency' ? check : c)) : [check, ...payload.checks];
  return { ...payload, invoice: { ...converted, foreign: { ...foreign, source: 'entered' } }, lines, checks };
}

export const recordPurchase = defineCommand({
  name: 'finance.purchase.record',
  input: z.object({
    payload: zPurchaseProposal,
    acceptFailedChecks: z.boolean().default(false),
    // The approver's posting date for an invoice dated in a locked month (#478); omitted, the invoice date.
    postingDate: zLocalDate.optional(),
  }),
  risk: 'R3',
  access: 'proposal',
  // The kind extraction gives its proposals (extract.ts).
  proposalKind: 'finance.purchase',
  handler: async (ctx, { payload, acceptFailedChecks, postingDate }) => {
    const { invoice } = payload;
    const direction = directionOf(payload);
    const sale = direction === 'sale';
    // Posted later than its invoice date (#478); the invoice date itself is the ordinary case.
    const lateDate = postingDate !== undefined && postingDate !== invoice.issueDate ? postingDate : null;
    if (lateDate) {
      // Today by the database clock, as lock_period() counts it (period-lock.ts databaseToday).
      const refusal = latePostingRefusal(direction, invoice.issueDate, lateDate, await databaseToday(ctx.trx));
      if (refusal) throw refusal;
    }
    // The checks shown in the Inbox are enforced here, not only in the UI.
    // A foreign-currency invoice is recorded only once converted to VND at a rate (#918): the invoice's own, or the one
    // the accountant entered on a revision. Its VND totals are worked out again from the invoice's own.
    const foreign = invoice.foreign ?? null;
    if (invoice.currency.toUpperCase() !== BOOK_CURRENCY) {
      if (foreign?.currency !== invoice.currency.toUpperCase()) {
        throw new DomainError('UNSUPPORTED_CURRENCY', 422, 'Hóa đơn ngoại tệ chưa có tỷ giá; hãy nhập tỷ giá khi sửa đề xuất rồi duyệt lại');
      }
      const rate = checkRate(foreign.rate);
      const subtotal = toDong(foreign.subtotal, rate);
      const vat = toDong(foreign.vatTotal, rate);
      if (!subtotal.equals(money(invoice.subtotal)) || !vat.equals(money(invoice.vatTotal)) || !subtotal.plus(vat).equals(money(invoice.total))) {
        throw new DomainError('FOREIGN_MISMATCH', 422, 'Số tiền quy đổi sang VND không khớp tỷ giá của hóa đơn');
      }
    } else if (foreign) {
      throw new DomainError('FOREIGN_MISMATCH', 422, 'Hóa đơn VND không có tỷ giá quy đổi');
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
    assertDirectionAccounts(direction, lines);
    await assertUsableAccounts(ctx, lines.map((l) => l.debitAccount));

    // A foreign-currency invoice says what it was in its entry's description, which the journal and the MISA export
    // show (#918).
    const memo = foreign ? `${journalMemo(payload)} (${foreignNote(foreign)})` : journalMemo(payload);
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
    // A replacement or an adjustment invoice (#916): link it to the original, and void the original a replacement takes
    // the place of, reversing its entry on the replacement's posting date, before the replacement is recorded.
    const related = invoice.related ?? null;
    const entryDate = lateDate ?? invoice.issueDate;
    const corrected = related ? await correctedDocument(ctx, direction, partyId, related) : null;
    let voidedOriginal: string | null = null;
    if (related?.kind === 'replacement' && corrected?.inForce) {
      const entry = await documentEntry(ctx, corrected.id);
      if (entryDate < entry.entry_date) {
        throw new DomainError('REPLACEMENT_BEFORE_ORIGINAL', 422, `Hóa đơn thay thế ghi sổ ngày ${dateLabel(entryDate)}, trước ngày ghi sổ của hóa đơn gốc ${dateLabel(entry.entry_date)}`, {
          entryDate,
          originalDate: entry.entry_date,
        });
      }
      await postReversal(ctx, entry, entryDate, `Thay thế bởi hóa đơn ${invoice.series}/${invoice.number}`.slice(0, 500));
      voidedOriginal = corrected.id;
    }
    const document = await ctx.trx
      .insertInto('crove_finance.purchase_document')
      .values({
        org_id: ctx.orgId,
        direction,
        party_id: partyId,
        invoice_series: invoice.series,
        invoice_number: invoice.number,
        invoice_date: invoice.issueDate,
        // Upper case: a proposal read before #918 may carry 'vnd', which the CHECK constraint compares with 'VND'.
        currency: invoice.currency.toUpperCase(),
        ...(foreign
          ? {
              exchange_rate: foreign.rate,
              exchange_rate_source: foreign.source,
              foreign_subtotal: foreign.subtotal,
              foreign_vat_amount: foreign.vatTotal,
              foreign_total: foreign.total,
            }
          : {}),
        subtotal: invoice.subtotal,
        vat_amount: invoice.vatTotal,
        total: invoice.total,
        payment_method: invoice.paymentMethod,
        tax_authority_code: invoice.taxAuthorityCode,
        source_file_id: payload.sourceFileId,
        proposal_id: ctx.proposalId,
        created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        replaces_document_id: replaces,
        ...(related
          ? {
              correction_kind: related.kind,
              corrects_document_id: corrected?.id ?? null,
              corrected_series: related.series,
              corrected_number: related.number,
              corrected_date: related.issueDate,
            }
          : {}),
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
    // The invoice's own VAT table (#685), written before the entry is posted: once a document has its entry, the
    // database refuses more rows for it (purchase_tax_rate_before_insert).
    const taxRates = invoice.taxBreakdown ?? [];
    if (taxRates.length > 0) {
      await ctx.trx
        .insertInto('crove_finance.purchase_tax_rate')
        .values(
          taxRates.map((t, i) => ({
            org_id: ctx.orgId,
            document_id: document.id,
            row_no: i + 1,
            vat_rate: t.rate,
            taxable_amount: t.taxableAmount,
            vat_amount: t.vatAmount,
          })),
        )
        .execute();
    }

    const journalEntryId = await postJournalEntry(ctx, {
      entryDate: lateDate ?? invoice.issueDate,
      description: memo,
      sourceType: 'finance.purchase_document',
      // A purchase invoice's approver may choose a later posting date; a sale posts on its invoice date.
      beforeOpening: sale ? 'fixed' : 'posting_date',
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
    const late = lateDate ? await lateReason(ctx, invoice.issueDate, lateDate) : null;

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
        .catch((error: unknown) => {
          // The sub-account was deactivated after the check above (the database checks it again under a lock).
          if (isInactiveDefaultRefusal(error)) throw new DomainError('ACCOUNT_INACTIVE', 422, `Tài khoản ${main.debitAccount} đã ngừng sử dụng; hãy chọn tài khoản khác`);
          throw error;
        });
    }

    ctx.audit({
      direction,
      ...(replaces ? { replaces_document_id: replaces } : {}),
      ...(related ? { correction_kind: related.kind, corrects_document_id: corrected?.id ?? null, voided_document_id: voidedOriginal } : {}),
      ...(lateDate ? { invoice_date: invoice.issueDate, posting_date: lateDate, late_reason: late } : {}),
    });
    const event = sale ? 'sale.recorded' : 'purchase.recorded';
    const correction = related ? ` (${related.kind === 'replacement' ? 'thay thế' : 'điều chỉnh'} hóa đơn ${related.series}/${related.number})` : '';
    const recorded = replaces ? `Ghi sổ lại ${memo} (thay chứng từ đã hủy)` : `Ghi sổ ${memo}${correction}`;
    await ctx.activity(
      'finance.purchase_document',
      document.id,
      event,
      lateDate
        ? `${recorded} vào ngày ${dateLabel(lateDate)} (${late === 'opening' ? 'ngày hóa đơn không sau ngày số dư đầu kỳ' : 'tháng của hóa đơn đã khóa sổ'})`
        : recorded,
    );
    await ctx.emit('finance.purchase.recorded', {
      documentId: document.id,
      journalEntryId,
      direction,
      ...(replaces ? { replacesDocumentId: replaces } : {}),
      ...(corrected ? { correctsDocumentId: corrected.id } : {}),
      ...(lateDate ? { postingDate: lateDate } : {}),
    });
    return {
      documentId: document.id,
      journalEntryId,
      ...(lateDate ? { postingDate: lateDate } : {}),
      ...(corrected ? { correctsDocumentId: corrected.id } : {}),
      ...(voidedOriginal ? { voidedDocumentId: voidedOriginal } : {}),
    };
  },
});
