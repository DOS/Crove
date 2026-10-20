// Worker job: read a received file, extract the invoice, run deterministic checks and raise a proposal.
// Files are parsed in crove-extract (plan §7.6, External-tenant gate T12); its answer is untrusted, validated
// against @crove/extract-contract by the client and checked again here before it becomes a proposal.
import { sql } from 'kysely';
import { z } from 'zod';
import type { ExtractClient, ExtractFailure } from '@crove/extract-contract';
import { zId, zPurchaseProposal, type DocumentDirection, type PurchaseProposal } from '@crove/kernel-contract';
import { defineQuery, readVerified, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { AiNotConfiguredError, AmountFormatError, type InvoiceReader } from '@crove/agent';
import { journalMemo } from './memo.ts';
import { isOwnTaxCode } from './own-tax-code.ts';
import {
  bookableLines,
  bookableSaleLines,
  buildPurchaseJournal,
  buildSalesJournal,
  checkInvoice,
  looksLikeEInvoiceXml,
  parseTaxCode,
  type InvoiceCheck,
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
    return file ? { ...file, hasExtraction: Boolean(extraction), due } : null;
  },
});

export interface InvoiceLookup {
  // 'sale' when the seller's tax code is the org's own or one of its branches (crove_kernel.tenant.tax_code, #313, #686).
  direction: DocumentDirection;
  vendorDefault: string | null;
  duplicateDocumentId: string | null;
  duplicateProposalId: string | null;
}

export const purchaseLookup = defineQuery({
  name: 'finance.extraction.lookup',
  // fileId: the file being read. Its own proposals are not duplicates of it (a re-extraction revises them).
  input: z.object({ fileId: zId, sellerTaxCode: z.string().nullable(), sellerName: z.string(), series: z.string(), number: z.string() }),
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
    let documents = ctx.trx
      .selectFrom('crove_finance.purchase_document as d')
      .select('d.id')
      .where('d.org_id', '=', ctx.orgId)
      .where('d.direction', '=', sale ? 'sale' : 'purchase')
      .where('d.invoice_series', '=', input.series)
      .where('d.invoice_number', '=', input.number)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('crove_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'))),
      );
    if (party) documents = documents.where('d.party_id', '=', party.id);
    const document = sale || party ? await documents.executeTakeFirst() : undefined;
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
    return {
      direction: sale ? 'sale' : 'purchase',
      vendorDefault: rule?.debit_account ?? null,
      duplicateDocumentId: document?.id ?? null,
      duplicateProposalId: duplicate?.id ?? null,
    };
  },
});

export interface ExtractDeps {
  runtime: Runtime;
  store: BlobStore;
  extractor: InvoiceReader | null;
  // The crove-extract client. The worker never parses PDF or XML itself.
  extract: ExtractClient;
  today?: () => string;
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

async function readInvoice(
  deps: ExtractDeps,
  file: { filename: string; content_type: string },
  bytes: Uint8Array,
): Promise<{ method: Method; invoice: ParsedInvoice | null; error: string | null }> {
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
      return { method: 'einvoice_xml', invoice: result.invoice, error: null };
    }
    if (file.content_type === 'application/pdf' || name.endsWith('.pdf')) {
      if (!deps.extractor) throw new AiNotConfiguredError('Chưa cấu hình AI nên chưa đọc được PDF; hãy gửi tệp XML hóa đơn điện tử');
      const result = await sandbox.extract('pdf_text', bytes);
      if (!result.ok) return { method: 'pdf_text_ai', invoice: null, error: unreadable(result) };
      const text = result.text.trim();
      if (text.length < 40) return { method: 'pdf_text_ai', invoice: null, error: 'PDF dạng ảnh scan chưa được hỗ trợ; hãy gửi ảnh chụp hoặc tệp XML' };
      const invoice = await deps.extractor.fromText(text);
      return { method: 'pdf_text_ai', invoice, error: invoice ? null : 'Tài liệu không phải hóa đơn mua vào' };
    }
    if (IMAGE_TYPES.includes(file.content_type)) {
      if (!deps.extractor) throw new AiNotConfiguredError('Chưa cấu hình AI nên chưa đọc được ảnh; hãy gửi tệp XML hóa đơn điện tử');
      const invoice = await deps.extractor.fromImage(bytes, file.content_type);
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
}

// Marks a run as unreadable so the file leaves the "processing" state: the first extraction (no version) if the
// file has none yet, or the pending re-extraction `version`. A no-op once that run has a result.
export async function recordExtractionFailure(runtime: Runtime, orgId: string, fileId: string, message: string, version?: number): Promise<void> {
  const actor = { type: 'system' as const, component: 'finance.extract' };
  const file = await runtime.query<ExtractionFile | null>('finance.extraction.file', { fileId, version }, { actor, orgId });
  if (!file || !file.due) return;
  await runtime.execute(
    'kernel.extraction.record',
    { fileId, version, method: 'unsupported', status: 'failed', result: null, checks: [], error: message, proposal: null },
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
): Promise<{ proposalId: string | null }> {
  const actor = { type: 'system' as const, component: 'finance.extract' };
  const file = await deps.runtime.query<ExtractionFile | null>('finance.extraction.file', { fileId, version }, { actor, orgId });
  if (!file || !file.due) return { proposalId: null };

  // The exact version the file row recorded, checked against its sha256 (ADR-0013): a swapped object is never parsed.
  const bytes = await readVerified(deps.store, { key: file.storage_key, generation: file.generation, sha256: file.sha256 });
  const { method, invoice, error } = await readInvoice(deps, file, bytes);

  const fail = (message: string, checks: InvoiceCheck[] = []) =>
    deps.runtime.execute<{ proposalId: string | null }>(
      'kernel.extraction.record',
      { fileId, version, method, status: 'failed', result: invoice ?? null, checks, error: message, proposal: null },
      { actor, orgId },
    );

  if (!invoice) return fail(error ?? 'Không đọc được chứng từ');

  const sellerTaxCode = parseTaxCode(invoice.seller.taxCode)?.normalized ?? null;
  const lookup = await deps.runtime.query<InvoiceLookup>(
    'finance.extraction.lookup',
    { fileId, sellerTaxCode, sellerName: invoice.seller.name, series: invoice.series, number: invoice.number },
    { actor, orgId },
  );

  const checks = checkInvoice(invoice, deps.today?.());
  if (lookup.duplicateDocumentId || lookup.duplicateProposalId) {
    checks.unshift({ id: 'duplicate', status: 'fail', message: 'Hóa đơn này đã có trong Inbox hoặc đã ghi sổ' });
  }
  // A sale (issue #313) books every line to revenue; a purchase proposes an expense or asset account per line.
  const sale = lookup.direction === 'sale';
  const lines = sale ? bookableSaleLines(invoice) : bookableLines(invoice, lookup.vendorDefault);
  if (lines.length === 0) return fail('Hóa đơn không có dòng hàng hóa, dịch vụ để hạch toán', checks);

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
      currency: invoice.currency,
      paymentMethod: invoice.paymentMethod,
      taxAuthorityCode: invoice.taxAuthorityCode,
      subtotal: invoice.subtotal,
      vatTotal: invoice.vatTotal,
      total: invoice.total,
      ...invoiceTaxTable(method, invoice),
    },
    lines,
    journal: sale ? buildSalesJournal(lines, invoice.vatTotal, memo) : buildPurchaseJournal(lines, invoice.vatTotal, memo),
    checks,
    sourceFileId: fileId,
    extractionMethod: method === 'unsupported' ? 'einvoice_xml' : method,
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
      },
    },
    { actor, orgId },
  );
}
