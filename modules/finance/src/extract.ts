// Worker job: read a received file, extract the invoice, run deterministic checks and raise a proposal.
// Files are parsed in crove-extract (plan §7.6, External-tenant gate T12); its answer is untrusted, validated
// against @crove/extract-contract by the client and checked again here before it becomes a proposal.
import { sql } from 'kysely';
import { z } from 'zod';
import type { ExtractClient, ExtractFailure } from '@crove/extract-contract';
import type { UsageMetric } from '@crove/db';
import { zId, zLocalDate, zPurchaseProposal, zRelatedInvoiceRef, type DocumentDirection, type PurchaseProposal, type RelatedInvoiceRef } from '@crove/kernel-contract';
import { defineQuery, readVerified, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { AiNotConfiguredError, AmountFormatError, type AiUsage, type InvoiceReader } from '@crove/agent';
import { journalMemo } from './memo.ts';
import { BOOK_CURRENCY, convertInvoice, type ForeignAmounts } from './domain/foreign-currency.ts';
import { isOwnTaxCode } from './own-tax-code.ts';
import { rulesForSuggestion } from './categorization.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import {
  bookableLines,
  classificationCheck,
  bookableSaleLines,
  buildPurchaseJournal,
  buildSalesJournal,
  checkInvoice,
  invoiceExchangeRate,
  lineContribution,
  looksLikeEInvoiceXml,
  money,
  Decimal,
  parseTaxCode,
  type InvoiceCheck,
  type LearnedRule,
  type ParsedInvoice,
} from '@crove/l10n-vn';

// The file to read and whether this run should happen: `version` names a pending re-extraction (issue #40), which
// runs only while that version is still pending; without it, the first extraction runs only if the file has none.
export const fileForExtraction = defineQuery({
  name: 'finance.extraction.file',
  input: z.object({ fileId: zId, version: z.number().int().positive().optional() }),
  access: 'system',
  handler: async (ctx, input) => {
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'filename', 'content_type', 'storage_key', 'generation', 'sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .executeTakeFirst();
    let query = ctx.trx
      .selectFrom('crove_kernel.extraction')
      .select('status')
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', input.fileId);
    if (input.version !== undefined) query = query.where('version', '=', input.version);
    const extraction = await query.limit(1).executeTakeFirst();
    const due = input.version === undefined ? !extraction : extraction?.status === 'pending';
    // "Dừng AI" (#886): a kill switch engaged for the org, or for the finance module, stops the AI reads of PDFs and
    // images; e-invoice XML is parsed without AI and goes on.
    const stopped = await ctx.trx
      .selectFrom('crove_kernel.kill_switch')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('released_at', 'is', null)
      .where((eb) => eb.or([eb('scope', '=', 'org'), eb.and([eb('scope', '=', 'module'), eb('target', '=', 'finance')])]))
      .limit(1)
      .executeTakeFirst();
    // And the operator's switch for every org (#886).
    const { rows: global } = await sql<{ on: boolean }>`SELECT crove_kernel.global_kill_switch_on('ai') AS on`.execute(ctx.trx);
    return file ? { ...file, hasExtraction: Boolean(extraction), due, aiStopped: Boolean(stopped) || global[0]?.on === true } : null;
  },
});

export interface InvoiceLookup {
  // 'sale' when the seller's tax code is the org's own or one of its branches (crove_kernel.tenant.tax_code, #313, #686).
  direction: DocumentDirection;
  vendorDefault: string | null;
  // The learned account rules of the vendor and of every vendor (#1399), for a purchase; none for a sale.
  learnedRules?: LearnedRule[];
  duplicateDocumentId: string | null;
  duplicateProposalId: string | null;
  // The document in force of the invoice a replacement or an adjustment corrects (#916), or null.
  relatedDocumentId: string | null;
}

// The check a duplicate invoice carries: from the lookup before the record, or from the record's own (#2137).
const DUPLICATE_CHECK: InvoiceCheck = { id: 'duplicate', status: 'fail', code: 'duplicate.found', message: 'Hóa đơn này đã có trong Inbox hoặc đã ghi sổ' };

export const purchaseLookup = defineQuery({
  name: 'finance.extraction.lookup',
  // fileId: the file being read. Its own proposals are not duplicates of it (a re-extraction revises them).
  input: z.object({
    fileId: zId,
    sellerTaxCode: z.string().nullable(),
    sellerName: z.string(),
    series: z.string(),
    number: z.string(),
    // The invoice a replacement or an adjustment names (#916).
    related: z.object({ series: z.string(), number: z.string() }).nullable().default(null),
    // The legal entity whose learned rules apply (#1280); omitted, the org's default entity.
    legalEntityId: zId.optional(),
  }),
  access: 'system',
  handler: async (ctx, input): Promise<InvoiceLookup> => {
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).executeTakeFirst();
    // A sale (issue #313): the org issued the invoice and numbers its own invoices, so a duplicate is the same series
    // and number whoever the customer is, and no account is remembered per customer.
    const sale = isOwnTaxCode(input.sellerTaxCode, org?.tax_code);
    const party =
      !sale && input.sellerTaxCode
        ? await ctx.trx
            .selectFrom('crove_kernel.party')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('tax_code', '=', input.sellerTaxCode)
            .executeTakeFirst()
        : undefined;
    const rule = party
      ? await ctx.trx
          .selectFrom('crove_finance.vendor_account_rule')
          .select('debit_account')
          .where('org_id', '=', ctx.orgId)
          .where('party_id', '=', party.id)
          .executeTakeFirst()
      : undefined;
    // A document voided by a reversal (#165) is no longer in the books, so it is not a duplicate. A purchase from a
    // supplier not yet in the books has no document.
    const inForce = (series: string, number: string) => {
      let documents = ctx.trx
        .selectFrom('crove_finance.purchase_document as d')
        .select('d.id')
        .where('d.org_id', '=', ctx.orgId)
        .where('d.direction', '=', sale ? 'sale' : 'purchase')
        .where('d.invoice_series', '=', series)
        .where('d.invoice_number', '=', number)
        .where(({ not, exists, selectFrom }) =>
          not(exists(selectFrom('crove_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'))),
        );
      if (party) documents = documents.where('d.party_id', '=', party.id);
      return sale || party ? documents.executeTakeFirst() : Promise.resolve(undefined);
    };
    const document = await inForce(input.series, input.number);
    const original = input.related ? await inForce(input.related.series, input.related.number) : undefined;
    const duplicate = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('kind', '=', 'finance.purchase')
      .where('status', 'in', ['pending', 'executed'])
      .where((eb) => eb.or([eb('source_file_id', 'is', null), eb('source_file_id', '!=', input.fileId)]))
      // Nor is an executed proposal whose document was voided.
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('crove_finance.purchase_document as d')
              .innerJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
              .select('d.id')
              .whereRef('d.org_id', '=', 'crove_kernel.proposal.org_id')
              .whereRef('d.proposal_id', '=', 'crove_kernel.proposal.id'),
          ),
        ),
      )
      .where(sql`coalesce(payload ->> 'direction', 'purchase')`, '=', sale ? 'sale' : 'purchase')
      .where(sql`payload #>> '{invoice,series}'`, '=', input.series)
      .where(sql`payload #>> '{invoice,number}'`, '=', input.number)
      .$if(!sale, (q) =>
        q.where(input.sellerTaxCode ? sql`payload #>> '{seller,taxCode}'` : sql`payload #>> '{seller,name}'`, '=', input.sellerTaxCode ?? input.sellerName),
      )
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    // The vendor whose learned rules apply: by tax code as above, or, for an invoice without one, by name as
    // finance.purchase.record finds or creates the party it learns for (upsertParty).
    const ruleParty =
      party ??
      (!sale && !input.sellerTaxCode && input.sellerName.trim()
        ? await ctx.trx
            .selectFrom('crove_kernel.party')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('tax_code', 'is', null)
            .where((eb) => eb(eb.fn('lower', ['name']), '=', input.sellerName.trim().toLowerCase()))
            .executeTakeFirst()
        : undefined);
    return {
      direction: sale ? 'sale' : 'purchase',
      vendorDefault: rule?.debit_account ?? null,
      learnedRules: sale ? [] : await rulesForSuggestion(ctx, ruleParty?.id ?? null, await resolveLegalEntity(ctx, input.legalEntityId)),
      duplicateDocumentId: document?.id ?? null,
      duplicateProposalId: duplicate?.id ?? null,
      relatedDocumentId: original?.id ?? null,
    };
  },
});

// The invoice a replacement or an adjustment corrects (#916), as the proposal keeps it: the date only when it is a
// calendar date, the original's document when it is in force.
function relatedRef(invoice: ParsedInvoice, documentId: string | null): RelatedInvoiceRef | null {
  const related = invoice.related;
  if (!related) return null;
  const ref = {
    kind: related.kind,
    template: related.template?.slice(0, 50) ?? null,
    series: related.series.slice(0, 50),
    number: related.number.slice(0, 50),
    issueDate: related.issueDate !== null && zLocalDate.safeParse(related.issueDate).success ? related.issueDate : null,
    documentId,
  };
  return zRelatedInvoiceRef.safeParse(ref).success ? ref : null;
}

const RELATED_KIND_LABELS = { replacement: 'thay thế', adjustment: 'điều chỉnh' } as const;

// Exported for the check-code test.
export // Whether the original is in the books: a warning when it is not, so the approver looks before a replacement is
// recorded next to an original it should have taken the place of.
function relatedCheck(related: RelatedInvoiceRef): InvoiceCheck {
  const invoice = `${related.series}/${related.number}`;
  if (related.documentId === null) {
    return {
      id: 'related',
      status: 'warn',
      code: related.kind === 'replacement' ? 'related.replaces_missing' : 'related.adjusts_missing',
      params: { invoice },
      message: `Hóa đơn ${RELATED_KIND_LABELS[related.kind]} cho hóa đơn ${invoice}, nhưng chưa thấy hóa đơn gốc trong sổ; kiểm tra trước khi duyệt`,
    };
  }
  return related.kind === 'replacement'
    ? {
        id: 'related',
        status: 'pass',
        code: 'related.replaces',
        params: { invoice },
        message: `Hóa đơn thay thế cho hóa đơn ${invoice}: khi duyệt, hệ thống đảo bút toán và hủy chứng từ của hóa đơn gốc`,
      }
    : {
        id: 'related',
        status: 'pass',
        code: 'related.adjusts',
        params: { invoice },
        message: `Hóa đơn điều chỉnh cho hóa đơn ${invoice}: ghi sổ phần chênh lệch, liên kết với hóa đơn gốc`,
      };
}

export interface ExtractDeps {
  runtime: Runtime;
  store: BlobStore;
  extractor: InvoiceReader | null;
  // The crove-extract client. The worker never parses PDF or XML itself.
  extract: ExtractClient;
  today?: () => string;
  // The per-org abuse limits (#675): extraction pages and AI cost in any 24 hours. Without them nothing is checked;
  // what a run used is recorded either way, for the usage report.
  limits?: Readonly<Record<UsageMetric, string>> | undefined;
  // The price of one million input and output tokens of the AI model, in the unit of the ai_cost limit. Without it AI
  // cost counts as zero.
  aiPrice?: { inputPerMTok: string; outputPerMTok: string } | undefined;
}

// What reading one document used: its pages once read (a PDF's page count, 1 for an image or an e-invoice XML; a file
// the sandbox refuses counts none) and the tokens of the AI calls made for it.
interface ReadUsage {
  pages: number;
  ai: AiUsage[];
}

// The cost of the AI calls of one read, as a decimal string with 6 decimals.
export function aiCost(usage: readonly AiUsage[], price: { inputPerMTok: string; outputPerMTok: string } | undefined): string {
  if (!price) return '0';
  let cost = new Decimal(0);
  for (const call of usage) {
    cost = cost.plus(new Decimal(call.inputTokens).times(price.inputPerMTok)).plus(new Decimal(call.outputTokens).times(price.outputPerMTok));
  }
  return cost.dividedBy(1_000_000).toFixed(6);
}

type Method = 'einvoice_xml' | 'pdf_text_ai' | 'image_ai' | 'unsupported';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Failures caused by the file itself are recorded and never retried; service failures throw and are retried.
function unreadable(result: ExtractFailure): string {
  switch (result.code) {
    case 'too_large':
      return 'Tệp quá lớn để đọc (tối đa 25 MB)';
    case 'timeout':
      return 'Đọc tệp quá lâu nên đã dừng; hãy kiểm tra lại tệp';
    case 'memory':
      return 'Tệp quá phức tạp để đọc; hãy kiểm tra lại tệp';
    default:
      // The sandbox says what is wrong with the file; the text stays plain data wherever it is shown.
      return result.message || 'Không đọc được chứng từ';
  }
}

// The message of a PDF or photo left unread while AI is stopped (#886); "Đọc lại" reads it once AI is back on.
export const AI_STOPPED_MESSAGE = 'AI đang tạm dừng trong tổ chức nên chưa đọc tệp này; bật lại AI rồi bấm "Đọc lại"';

async function readInvoice(
  deps: ExtractDeps,
  file: { filename: string; content_type: string; aiStopped: boolean },
  bytes: Uint8Array,
  used: ReadUsage,
): Promise<{ method: Method; invoice: ParsedInvoice | null; error: string | null }> {
  const onUsage = (usage: AiUsage) => {
    used.ai.push(usage);
  };
  // This process has no parser (External-tenant gate T12): without the crove-extract client it fails closed,
  // in tests as everywhere else, and the job is retried.
  const sandbox = deps.extract as ExtractClient | undefined;
  if (!sandbox) throw new Error('extractAndPropose needs the crove-extract client');
  const name = file.filename.toLowerCase();
  // A look at the first bytes picks the parser; nothing is parsed here.
  const isXml = file.content_type.includes('xml') || name.endsWith('.xml') || looksLikeEInvoiceXml(bytes);
  try {
    if (isXml) {
      const result = await sandbox.extract('einvoice_xml', bytes);
      if (!result.ok) return { method: 'einvoice_xml', invoice: null, error: unreadable(result) };
      used.pages = 1;
      return { method: 'einvoice_xml', invoice: result.invoice, error: null };
    }
    if (file.content_type === 'application/pdf' || name.endsWith('.pdf')) {
      // A stopped AI says so first, whether or not this deployment has a model (#1718): the switch is what the
      // person can act on, and it reads the same on every deployment.
      if (file.aiStopped) return { method: 'pdf_text_ai', invoice: null, error: AI_STOPPED_MESSAGE };
      if (!deps.extractor) throw new AiNotConfiguredError('Chưa cấu hình AI nên chưa đọc được PDF; hãy gửi tệp XML hóa đơn điện tử');
      const result = await sandbox.extract('pdf_text', bytes);
      if (!result.ok) return { method: 'pdf_text_ai', invoice: null, error: unreadable(result) };
      used.pages = Math.max(result.pages, 1);
      const text = result.text.trim();
      if (text.length < 40) return { method: 'pdf_text_ai', invoice: null, error: 'PDF dạng ảnh scan chưa được hỗ trợ; hãy gửi ảnh chụp hoặc tệp XML' };
      const invoice = await deps.extractor.fromText(text, onUsage);
      return { method: 'pdf_text_ai', invoice, error: invoice ? null : 'Tài liệu không phải hóa đơn mua vào' };
    }
    if (IMAGE_TYPES.includes(file.content_type)) {
      if (file.aiStopped) return { method: 'image_ai', invoice: null, error: AI_STOPPED_MESSAGE };
      if (!deps.extractor) throw new AiNotConfiguredError('Chưa cấu hình AI nên chưa đọc được ảnh; hãy gửi tệp XML hóa đơn điện tử');
      used.pages = 1;
      const invoice = await deps.extractor.fromImage(bytes, file.content_type, onUsage);
      return { method: 'image_ai', invoice, error: invoice ? null : 'Ảnh không phải hóa đơn mua vào' };
    }
    return { method: 'unsupported', invoice: null, error: 'Định dạng tệp chưa được hỗ trợ (chỉ nhận XML, PDF, JPG, PNG, WEBP)' };
  } catch (error) {
    if (error instanceof AiNotConfiguredError || error instanceof AmountFormatError) {
      return { method: isXml ? 'einvoice_xml' : 'unsupported', invoice: null, error: error.message };
    }
    throw error;
  }
}

// The invoice's own VAT table (#685), from e-invoice XML only: the VAT working splits the invoice by rate with it. A
// table the proposal cannot hold (a rate longer than a line's, an amount out of range) is left out rather than failing
// the extraction; the VAT working then estimates the split from the lines, as for a PDF.
// The invoice in VND when it is in another currency with its own exchange rate (#918), else null.
function bookedInVnd(invoice: ParsedInvoice): { invoice: ParsedInvoice; foreign: ForeignAmounts } | null {
  if (invoice.currency.toUpperCase() === BOOK_CURRENCY) return null;
  const rate = invoiceExchangeRate(invoice);
  if (!rate) return null;
  // A discount line carries a positive amount that counts negatively (lineContribution): it is converted by what it
  // counts for and keeps its sign convention.
  const flipped = (l: ParsedInvoice['lines'][number]) => l.nature === 'discount' && money(l.amount).isPositive();
  return convertInvoice<ParsedInvoice['lines'][number], ParsedInvoice>(
    invoice,
    rate,
    (l) => lineContribution(l),
    (l, amount) => ({ ...l, amount: flipped(l) ? money(amount).negated().toFixed() : amount }),
  );
}

function invoiceTaxTable(method: Method, invoice: ParsedInvoice): Pick<PurchaseProposal['invoice'], 'taxBreakdown'> {
  if (method !== 'einvoice_xml' || invoice.taxBreakdown.length === 0) return {};
  const parsed = zPurchaseProposal.shape.invoice.shape.taxBreakdown.safeParse(invoice.taxBreakdown);
  return parsed.success && parsed.data ? { taxBreakdown: parsed.data } : {};
}

interface ExtractionFile {
  id: string;
  filename: string;
  content_type: string;
  storage_key: string;
  generation: string | null;
  sha256: string;
  hasExtraction: boolean;
  due: boolean;
  aiStopped: boolean;
}

// Marks a run as unreadable so the file leaves the "processing" state: the first extraction (no version) if the
// file has none yet, or the pending re-extraction `version`. A no-op once that run has a result.
export async function recordExtractionFailure(
  runtime: Runtime,
  orgId: string,
  fileId: string,
  message: string,
  version?: number,
  // `service` when the reading service kept failing (#1998); the prober counts those.
  failure: 'service' | 'document' = 'document',
): Promise<void> {
  const actor = { type: 'system' as const, component: 'finance.extract' };
  const file = await runtime.query<ExtractionFile | null>('finance.extraction.file', { fileId, version }, { actor, orgId });
  if (!file || !file.due) return;
  await runtime.execute(
    'kernel.extraction.record',
    { fileId, version, method: 'unsupported', status: 'failed', result: null, checks: [], error: message, proposal: null, failure },
    { actor, orgId },
  );
}

// Reads the file and records the run: the first extraction of a new file, or (with `version`) a requested
// re-extraction, whose result becomes a new revision of the file's pending proposal (issue #40).
export async function extractAndPropose(
  deps: ExtractDeps,
  orgId: string,
  fileId: string,
  version?: number,
): Promise<{ proposalId: string | null; deferred?: string }> {
  const actor = { type: 'system' as const, component: 'finance.extract' };
  const file = await deps.runtime.query<ExtractionFile | null>('finance.extraction.file', { fileId, version }, { actor, orgId });
  if (!file || !file.due) return { proposalId: null };

  // Over the org's daily extraction pages or AI cost (#675) the document is kept and not read. A first read waits for
  // the org's next budget: the worker queues it again for `deferred`, and the Inbox shows it as waiting. A re-extraction
  // someone asked for is recorded as failed with when to ask again, so the pending proposal is not held for a day.
  if (deps.limits) {
    const { extraction_pages, ai_cost } = deps.limits;
    const over = await deps.runtime.query<{ metric: UsageMetric; retryAt: string } | null>(
      'kernel.usage.over',
      { metrics: ['extraction_pages', 'ai_cost'], limits: { extraction_pages, ai_cost } },
      { actor, orgId },
    );
    if (over && version !== undefined) {
      await recordExtractionFailure(deps.runtime, orgId, fileId, 'Tổ chức đã dùng hết hạn mức đọc chứng từ trong 24 giờ; hãy bấm Đọc lại vào ngày mai', version);
      return { proposalId: null };
    }
    if (over) {
      await deps.runtime.execute('kernel.usage.defer', { metric: over.metric, subjectType: 'file', subjectId: fileId, retryAt: over.retryAt }, { actor, orgId });
      return { proposalId: null, deferred: over.retryAt };
    }
  }

  // The exact version the file row recorded, checked against its sha256 (ADR-0013): a swapped object is never parsed.
  const bytes = await readVerified(deps.store, { key: file.storage_key, generation: file.generation, sha256: file.sha256 });
  const used: ReadUsage = { pages: 0, ai: [] };
  let read: Awaited<ReturnType<typeof readInvoice>>;
  try {
    read = await readInvoice(deps, file, bytes, used);
  } finally {
    // What the read used counts against the org's limits even when the job fails after it and is retried. Best
    // effort: a failure to record is logged and never hides the read's own error or result.
    const cost = aiCost(used.ai, deps.aiPrice);
    if (used.pages > 0 || /[1-9]/.test(cost)) {
      try {
        await deps.runtime.execute(
          'kernel.usage.record',
          { entries: [{ metric: 'extraction_pages', amount: String(used.pages) }, { metric: 'ai_cost', amount: cost }] },
          { actor, orgId },
        );
      } catch (recordError) {
        console.error(`[extract] file ${fileId}: could not record its usage`, recordError instanceof Error ? recordError.message : recordError);
      }
    }
  }
  const { method, invoice, error } = read;

  const fail = (message: string, checks: InvoiceCheck[] = []) =>
    deps.runtime.execute<{ proposalId: string | null }>(
      'kernel.extraction.record',
      { fileId, version, method, status: 'failed', result: invoice ?? null, checks, error: message, proposal: null },
      { actor, orgId },
    );

  if (!invoice) return fail(error ?? 'Không đọc được chứng từ');

  const sellerTaxCode = parseTaxCode(invoice.seller.taxCode)?.normalized ?? null;
  const lookupInput = {
    sellerTaxCode,
    sellerName: invoice.seller.name,
    series: invoice.series,
    number: invoice.number,
    related: invoice.related ? { series: invoice.related.series, number: invoice.related.number } : null,
  };
  const lookup = await deps.runtime.query<InvoiceLookup>('finance.extraction.lookup', { fileId, ...lookupInput }, { actor, orgId });

  const checks = checkInvoice(invoice, deps.today?.());
  // A foreign-currency e-invoice with its own rate is proposed in VND (#918); the checks above read it as issued.
  const converted = bookedInVnd(invoice);
  const booked = converted?.invoice ?? invoice;
  if (lookup.duplicateDocumentId || lookup.duplicateProposalId) checks.unshift(DUPLICATE_CHECK);
  const related = relatedRef(invoice, lookup.relatedDocumentId);
  if (related) checks.push(relatedCheck(related));
  // A sale (issue #313) books every line to revenue; a purchase proposes an expense or asset account per line.
  const sale = lookup.direction === 'sale';
  const lines = sale ? bookableSaleLines(booked) : bookableLines(booked, lookup.vendorDefault, lookup.learnedRules ?? []);
  if (lines.length === 0) return fail('Hóa đơn không có dòng hàng hóa, dịch vụ để hạch toán', checks);
  // A purchase line no rule matched has no account yet (#2091): a warning names those lines, and recording refuses them
  // until a reviewer picks the account. A sale's lines are all revenue, so it has none. Nothing is added when every
  // line has its account; the check is replaced by its pass when a revision classifies the last line.
  const classification = sale ? null : classificationCheck(lines);
  if (classification?.status === 'warn') checks.push(classification);

  const seller = { ...invoice.seller, taxCode: sellerTaxCode ?? invoice.seller.taxCode };
  const buyer = sale ? { ...invoice.buyer, taxCode: parseTaxCode(invoice.buyer.taxCode)?.normalized ?? invoice.buyer.taxCode } : invoice.buyer;
  const direction = sale ? { direction: 'sale' as const } : {};
  const memo = journalMemo({ ...direction, seller, buyer, invoice });
  const payload: PurchaseProposal = {
    ...direction,
    seller,
    buyer,
    invoice: {
      template: invoice.template,
      series: invoice.series,
      number: invoice.number,
      issueDate: invoice.issueDate,
      // Upper case, as the document stores it (purchase_document_foreign_amounts compares it with 'VND').
      currency: invoice.currency.toUpperCase(),
      paymentMethod: invoice.paymentMethod,
      taxAuthorityCode: invoice.taxAuthorityCode,
      subtotal: booked.subtotal,
      vatTotal: booked.vatTotal,
      total: booked.total,
      ...invoiceTaxTable(method, booked),
      ...(related ? { related } : {}),
      ...(converted ? { foreign: { ...converted.foreign, source: 'invoice' as const } } : {}),
    },
    lines,
    journal: sale ? buildSalesJournal(lines, booked.vatTotal, memo) : buildPurchaseJournal(lines, booked.vatTotal, memo),
    checks,
    sourceFileId: fileId,
    extractionMethod: method === 'unsupported' ? 'einvoice_xml' : method,
    // The signature verification from the sandbox (#674). An invoice read by AI has no signature to verify; an XML
    // answer from a sandbox older than #674 has no verification, which leaves it out.
    ...(invoice.signature
      ? { signature: { status: invoice.signature.status, reason: invoice.signature.reason } }
      : method === 'einvoice_xml'
        ? {}
        : { signature: { status: 'not_applicable' as const, reason: null } }),
  };
  // AI output can carry values the schema refuses (for example an impossible date); never store those as a proposal.
  if (!zPurchaseProposal.safeParse(payload).success) {
    return fail('Dữ liệu đọc được không hợp lệ (ví dụ ngày lập hóa đơn); hãy kiểm tra chứng từ gốc', checks);
  }

  return deps.runtime.execute<{ proposalId: string | null }>(
    'kernel.extraction.record',
    {
      fileId,
      version,
      method,
      status: 'done',
      result: invoice,
      checks,
      error: null,
      proposal: {
        kind: 'finance.purchase',
        command: 'finance.purchase.record',
        title: `${memo}`.slice(0, 300),
        payload,
        duplicateOf: lookup.duplicateProposalId,
        // Documents are read at the same time: the record asks the lookup again under a lock on this invoice, so two
        // copies in one batch cannot both pass (#2137). The key is the identity the lookup matches on.
        duplicateGuard: {
          // Hashed: a seller name can be 500 characters, and the key is only a name for the lock.
          key: sha256Hex(new TextEncoder().encode(JSON.stringify([lookup.direction === 'sale' ? 'sale' : 'purchase', lookup.direction === 'sale' ? '' : (sellerTaxCode ?? invoice.seller.name), invoice.series, invoice.number]))),
          lookup: lookupInput,
          check: DUPLICATE_CHECK,
        },
      },
    },
    { actor, orgId },
  );
}
