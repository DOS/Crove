// The document eval's set and its reader (#687). A set is a directory (the committed synthetic one, or AI_EVAL_DIR
// for the private one, outside the repository): each document (.xml, .pdf, .jpg, .jpeg, .png, .webp) next to a
// <name>.json with its expected answer (zExtractionFixture), in any subdirectory. Each document is read through
// its production path: the crove-extract sandbox for XML and PDF text (the parser process, as the worker calls
// it), the extractor's fromText for the PDF text and fromImage for a photo.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createExtractApp } from '@crove/extract';
import { createExtractClient, type ExtractClient } from '@crove/extract-contract';
import type { InvoiceLine, ParsedInvoice } from '@crove/l10n-vn';
import { classifyAiError, documentType, scoreExtraction, zExtractionFixture, type DocumentKind, type DocumentScore, type ExpectedInvoice, type InvoiceReader } from '../src/index.ts';

export const SYNTHETIC_DOCUMENTS = join(import.meta.dirname, 'fixtures', 'documents');

export interface EvalDocument {
  // The path under the set's directory, without the extension.
  id: string;
  kind: DocumentKind;
  mediaType: string;
  path: string;
  expected: ExpectedInvoice | null;
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

// Every document of the set with its expected answer. A document without one, or an expected answer without its
// document, is an error: a set that silently drops files measures less than it claims.
export function loadDocumentSet(dir: string): EvalDocument[] {
  const files = walk(dir);
  const expectations = new Set(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)));
  const problems: string[] = [];
  const documents: EvalDocument[] = [];
  for (const path of files) {
    const type = documentType(path);
    if (!type) continue;
    const base = path.slice(0, path.lastIndexOf('.'));
    const id = relative(dir, base);
    if (!expectations.delete(base)) {
      problems.push(`${id}: no ${id}.json next to the document`);
      continue;
    }
    const spec = zExtractionFixture.safeParse(JSON.parse(readFileSync(`${base}.json`, 'utf8')));
    if (!spec.success) {
      problems.push(`${id}.json: ${spec.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      continue;
    }
    documents.push({ id, kind: type.kind, mediaType: type.mediaType, path, expected: spec.data.expected });
  }
  for (const base of expectations) problems.push(`${relative(dir, base)}.json: no document with this name`);
  if (problems.length) throw new Error(`document set ${dir}:\n${problems.join('\n')}`);
  if (documents.length === 0) throw new Error(`document set ${dir} has no documents`);
  return documents;
}

// crove-extract in this process's address space, its parser in the sandboxed child process, as the kernel tests use it.
export function inProcessExtract(): ExtractClient {
  const app = createExtractApp({ concurrency: 2 });
  return createExtractClient({ url: 'http://crove-extract.eval', fetch: async (input, init) => app.fetch(new Request(input, init)) });
}

// Note lines (TChat 4 in the XML) carry no amount and are never booked; the AI paths never return them.
function withoutNotes(invoice: ParsedInvoice | null): ParsedInvoice | null {
  if (!invoice) return invoice;
  const lines: InvoiceLine[] = invoice.lines.filter((l) => l.nature !== 'note');
  return { ...invoice, lines };
}

// Reads and scores one document. A refused answer (a parser failure, an unreadable amount, output off the schema)
// scores zero with its error; an endpoint failure (HTTP, timeout, network) says nothing about accuracy and throws.
export async function scoreDocument(document: EvalDocument, deps: { extract: ExtractClient; reader: InvoiceReader | null }): Promise<DocumentScore> {
  const bytes = new Uint8Array(readFileSync(document.path));
  const scored = (actual: ParsedInvoice | null | undefined, error: string | null = null): DocumentScore => ({
    kind: document.kind,
    ...scoreExtraction(document.id, document.expected, actual === undefined ? undefined : withoutNotes(actual), error),
  });
  if (document.kind === 'xml') {
    const result = await deps.extract.extract('einvoice_xml', bytes);
    return result.ok ? scored(result.invoice) : scored(undefined, `${result.code}: ${result.message}`);
  }
  if (!deps.reader) throw new Error(`${document.id}: a ${document.kind} document needs the AI endpoint (AI_BASE_URL, AI_MODEL)`);
  try {
    if (document.kind === 'pdf') {
      const result = await deps.extract.extract('pdf_text', bytes);
      if (!result.ok) return scored(undefined, `${result.code}: ${result.message}`);
      return scored(await deps.reader.fromText(result.text.trim()));
    }
    return scored(await deps.reader.fromImage(bytes, document.mediaType));
  } catch (error) {
    if (classifyAiError(error).kind !== 'unknown') throw error;
    return scored(undefined, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}
