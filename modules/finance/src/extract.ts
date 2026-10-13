// Worker job: read a received file, extract the invoice, run deterministic checks and raise a proposal.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zPurchaseProposal, type PurchaseProposal } from '@crove/kernel-contract';
import { defineQuery, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { AiNotConfiguredError, AmountFormatError, type InvoiceExtractor } from '@crove/agent';
import {
  EInvoiceParseError,
  bookableLines,
  buildPurchaseJournal,
  checkInvoice,
  looksLikeEInvoiceXml,
  parseEInvoiceXml,
  parseTaxCode,
  type InvoiceCheck,
  type ParsedInvoice,
} from '@crove/l10n-vn';

export const fileForExtraction = defineQuery({
  name: 'finance.extraction.file',
  input: z.object({ fileId: zId }),
  access: 'system',
  handler: async (ctx, input) => {
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'filename', 'content_type', 'storage_key'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .executeTakeFirst();
    const extraction = await ctx.trx
      .selectFrom('crove_kernel.extraction')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', input.fileId)
      .executeTakeFirst();
    return file ? { ...file, hasExtraction: Boolean(extraction) } : null;
  },
});

export const purchaseLookup = defineQuery({
  name: 'finance.extraction.lookup',
  input: z.object({ sellerTaxCode: z.string().nullable(), sellerName: z.string(), series: z.string(), number: z.string() }),
  access: 'system',
  handler: async (ctx, input) => {
    const party = input.sellerTaxCode
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
    const document = party
      ? await ctx.trx
          .selectFrom('crove_finance.purchase_document')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('party_id', '=', party.id)
          .where('invoice_series', '=', input.series)
          .where('invoice_number', '=', input.number)
          .executeTakeFirst()
      : undefined;
    const duplicate = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('kind', '=', 'finance.purchase')
      .where('status', 'in', ['pending', 'executed'])
      .where(sql`payload #>> '{invoice,series}'`, '=', input.series)
      .where(sql`payload #>> '{invoice,number}'`, '=', input.number)
      .where(input.sellerTaxCode ? sql`payload #>> '{seller,taxCode}'` : sql`payload #>> '{seller,name}'`, '=', input.sellerTaxCode ?? input.sellerName)
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    return {
      vendorDefault: rule?.debit_account ?? null,
      duplicateDocumentId: document?.id ?? null,
      duplicateProposalId: duplicate?.id ?? null,
    };
  },
});

export interface ExtractDeps {
  runtime: Runtime;
  store: BlobStore;
  extractor: InvoiceExtractor | null;
  today?: () => string;
}

type Method = 'einvoice_xml' | 'pdf_text_ai' | 'image_ai' | 'unsupported';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  // Never let pdf.js evaluate code from the document.
  const pdf = await getDocumentProxy(bytes, { isEvalSupported: false } as Parameters<typeof getDocumentProxy>[1]);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : text;
}

async function readInvoice(
  deps: ExtractDeps,
  file: { filename: string; content_type: string },
  bytes: Uint8Array,
): Promise<{ method: Method; invoice: ParsedInvoice | null; error: string | null }> {
  const name = file.filename.toLowerCase();
  const isXml = file.content_type.includes('xml') || name.endsWith('.xml') || looksLikeEInvoiceXml(bytes);
  try {
    if (isXml) return { method: 'einvoice_xml', invoice: parseEInvoiceXml(bytes), error: null };
    if (file.content_type === 'application/pdf' || name.endsWith('.pdf')) {
      if (!deps.extractor) throw new AiNotConfiguredError('Chưa cấu hình AI nên chưa đọc được PDF; hãy gửi tệp XML hóa đơn điện tử');
      const text = (await pdfText(bytes)).trim();
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
    if (error instanceof EInvoiceParseError || error instanceof AiNotConfiguredError || error instanceof AmountFormatError) {
      return { method: isXml ? 'einvoice_xml' : 'unsupported', invoice: null, error: error.message };
    }
    throw error;
  }
}

// Marks a file as unreadable so it leaves the "processing" state; a no-op if it already has a result.
export async function recordExtractionFailure(runtime: Runtime, orgId: string, fileId: string, message: string): Promise<void> {
  const actor = { type: 'system' as const, component: 'finance.extract' };
  const file = await runtime.query<{ hasExtraction: boolean } | null>('finance.extraction.file', { fileId }, { actor, orgId });
  if (!file || file.hasExtraction) return;
  await runtime.execute(
    'kernel.extraction.record',
    { fileId, method: 'unsupported', status: 'failed', result: null, checks: [], error: message, proposal: null },
    { actor, orgId },
  );
}

export async function extractAndPropose(deps: ExtractDeps, orgId: string, fileId: string): Promise<{ proposalId: string | null }> {
  const actor = { type: 'system' as const, component: 'finance.extract' };
  const file = await deps.runtime.query<{
    id: string;
    filename: string;
    content_type: string;
    storage_key: string;
    hasExtraction: boolean;
  } | null>('finance.extraction.file', { fileId }, { actor, orgId });
  if (!file || file.hasExtraction) return { proposalId: null };

  const bytes = await deps.store.get(file.storage_key);
  const { method, invoice, error } = await readInvoice(deps, file, bytes);

  const fail = (message: string, checks: InvoiceCheck[] = []) =>
    deps.runtime.execute<{ proposalId: string | null }>(
      'kernel.extraction.record',
      { fileId, method, status: 'failed', result: invoice ?? null, checks, error: message, proposal: null },
      { actor, orgId },
    );

  if (!invoice) return fail(error ?? 'Không đọc được chứng từ');

  const sellerTaxCode = parseTaxCode(invoice.seller.taxCode)?.normalized ?? null;
  const lookup = await deps.runtime.query<{ vendorDefault: string | null; duplicateDocumentId: string | null; duplicateProposalId: string | null }>(
    'finance.extraction.lookup',
    { sellerTaxCode, sellerName: invoice.seller.name, series: invoice.series, number: invoice.number },
    { actor, orgId },
  );

  const checks = checkInvoice(invoice, deps.today?.());
  if (lookup.duplicateDocumentId || lookup.duplicateProposalId) {
    checks.unshift({ id: 'duplicate', status: 'fail', message: 'Hóa đơn này đã có trong Inbox hoặc đã ghi sổ' });
  }
  const lines = bookableLines(invoice, lookup.vendorDefault);
  if (lines.length === 0) return fail('Hóa đơn không có dòng hàng hóa, dịch vụ để hạch toán', checks);

  const memo = `HĐ ${invoice.series ? `${invoice.series}-` : ''}${invoice.number} ${invoice.seller.name}`.trim();
  const payload: PurchaseProposal = {
    seller: { ...invoice.seller, taxCode: sellerTaxCode ?? invoice.seller.taxCode },
    buyer: invoice.buyer,
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
    },
    lines,
    journal: buildPurchaseJournal(lines, invoice.vatTotal, memo),
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
