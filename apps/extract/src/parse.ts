// The parsers. Runs only inside a parser process started by sandbox.ts: no network, no file writes, no child
// processes, no environment and a capped heap. Every answer is checked against the shared contract before it
// leaves, so the worker never sees a shape it does not expect.
import PostalMime from 'postal-mime';
import type { Address } from 'postal-mime';
import { EXTRACT_LIMITS, zExtractSuccess, type ExtractFailure, type ExtractKind, type ExtractResponse, type ExtractSuccess } from '@crove/extract-contract';
import { EInvoiceParseError, parseEInvoiceXml } from './einvoice-xml.ts';

const MiB = 1024 * 1024;

export function failure(code: ExtractFailure['code'], message: string): ExtractFailure {
  return { ok: false, code, message: message.slice(0, EXTRACT_LIMITS.maxErrorChars) };
}

function cap(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.slice(0, EXTRACT_LIMITS.maxStringChars);
}

async function pdfText(bytes: Uint8Array): Promise<ExtractSuccess> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  // Never let pdf.js evaluate code from the document; the process also refuses code generation from strings.
  const pdf = await getDocumentProxy(bytes, { isEvalSupported: false } as Parameters<typeof getDocumentProxy>[1]);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const joined = Array.isArray(text) ? text.join('\n') : text;
  return { ok: true, kind: 'pdf_text', text: joined.slice(0, EXTRACT_LIMITS.maxTextChars), pages: totalPages };
}

function addressOf(address: Address | undefined): string | null {
  return address && typeof address.address === 'string' && address.address !== '' ? address.address : null;
}

function base64Of(content: ArrayBuffer | Uint8Array | string, encoding: string | undefined): string {
  if (typeof content === 'string') return encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64');
  return Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content)).toString('base64');
}

async function mime(bytes: Uint8Array): Promise<ExtractSuccess> {
  const email = await PostalMime.parse(bytes, {
    attachmentEncoding: 'base64',
    maxNestingDepth: 32,
    maxHeadersSize: 1 * MiB,
    maxPartCount: 1000,
  });
  return {
    ok: true,
    kind: 'mime',
    email: {
      messageId: cap(email.messageId),
      from: cap(addressOf(email.from)),
      subject: cap(email.subject),
      deliveredTo: cap(email.deliveredTo),
      to: (email.to ?? [])
        .map(addressOf)
        .filter((a): a is string => a !== null)
        .slice(0, EXTRACT_LIMITS.maxRecipients)
        .map((a) => a.slice(0, EXTRACT_LIMITS.maxStringChars)),
      // Only the first parts are returned, as the worker has always read them.
      attachments: email.attachments.slice(0, EXTRACT_LIMITS.maxAttachments).map((a) => ({
        filename: cap(a.filename),
        content: base64Of(a.content, a.encoding),
      })),
    },
  };
}

async function parseKind(kind: ExtractKind, bytes: Uint8Array): Promise<ExtractSuccess> {
  switch (kind) {
    case 'einvoice_xml':
      // fast-xml-parser with entity processing off; DOCTYPE and ENTITY are refused before parsing.
      return { ok: true, kind, invoice: { ...parseEInvoiceXml(bytes), source: 'einvoice_xml' } };
    case 'pdf_text':
      return pdfText(bytes);
    case 'mime':
      return mime(bytes);
  }
}

const UNREADABLE: Record<ExtractKind, string> = {
  einvoice_xml: 'Không đọc được XML hóa đơn điện tử',
  pdf_text: 'Không đọc được tệp PDF',
  mime: 'Không đọc được thư điện tử',
};

export async function parse(kind: ExtractKind, bytes: Uint8Array): Promise<ExtractResponse> {
  let result: ExtractSuccess;
  try {
    result = await parseKind(kind, bytes);
  } catch (error) {
    // The e-invoice parser explains what is wrong; other parser errors are not passed on.
    if (error instanceof EInvoiceParseError) return failure('invalid', error.message);
    // A stack overflow (deeply nested input) or an impossible allocation: the input is beyond what we read.
    if (error instanceof RangeError) return failure('invalid', `${UNREADABLE[kind]}: tệp vượt giới hạn xử lý`);
    return failure('invalid', UNREADABLE[kind]);
  }
  const checked = zExtractSuccess.safeParse(result);
  if (!checked.success) return failure('invalid', `${UNREADABLE[kind]}: dữ liệu vượt giới hạn cho phép`);
  return checked.data;
}
