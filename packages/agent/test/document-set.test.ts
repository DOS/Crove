// The document eval without an AI endpoint (#687): the committed synthetic set is complete, its e-invoice XML reads
// through the sandboxed parser with every field right, and the set loader refuses a document without its expected
// answer. The AI kinds run in document-eval.ai.test.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkInvoice, parseTaxCode } from '@crove/l10n-vn';
import { expectedAsParsed, summarizeDocumentEval } from '../src/index.ts';
import { inProcessExtract, loadDocumentSet, scoreDocument, SYNTHETIC_DOCUMENTS } from './documents.ts';

describe('synthetic document set', () => {
  const documents = loadDocumentSet(SYNTHETIC_DOCUMENTS);

  it('has one document of each kind, each with its expected answer', () => {
    expect(documents.map((d) => [d.id, d.kind])).toEqual([
      ['synthetic-einvoice', 'xml'],
      ['synthetic-pdf-invoice', 'pdf'],
      ['synthetic-photo-invoice', 'image'],
    ]);
  });

  // Plan §8.7, as for the text fixtures: a checksum-valid tax code could belong to a real business, and a 12-digit
  // run could be a real national ID. The PDF and the photo carry the same codes as their answers (checked by the
  // AI eval reading them); the XML is text.
  it.each(documents.map((d) => [d.id, d] as const))('%s uses only checksum-invalid tax codes and passes the checks', (_id, document) => {
    const texts = [JSON.stringify(document.expected), ...(document.kind === 'xml' ? [readFileSync(document.path, 'utf8')] : [])];
    for (const text of texts) {
      expect(text).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
      for (const run of text.match(/(?<!\d)\d{10}(-\d{3})?(?!\d)/g) ?? []) {
        expect(parseTaxCode(run)?.checksumValid, run).toBe(false);
      }
    }
    expect(checkInvoice(expectedAsParsed(document.expected!)).filter((c) => c.status === 'fail').map((c) => c.id)).toEqual([]);
  });

  it('reads the e-invoice XML through the parser with every field right, the note line left out', async () => {
    const xml = documents.find((d) => d.kind === 'xml')!;
    const score = await scoreDocument(xml, { extract: inProcessExtract(), reader: null });
    expect(score.fields.filter((f) => !f.match)).toEqual([]);
    expect(score).toMatchObject({ kind: 'xml', error: null, failedChecks: [] });
    expect(summarizeDocumentEval([score])).toMatchObject({ passed: true, xmlAmountMisses: [] });
  });

  it('sends the PDF text and the photo bytes to the reader, and scores what it returns', async () => {
    const seen: string[] = [];
    const reader = {
      fromText: async (text: string) => {
        seen.push(text);
        return null;
      },
      fromImage: async (bytes: Uint8Array, mediaType: string) => {
        seen.push(`${mediaType} ${bytes.byteLength > 1000}`);
        return null;
      },
    };
    const extract = inProcessExtract();
    const pdf = await scoreDocument(documents.find((d) => d.kind === 'pdf')!, { extract, reader });
    const photo = await scoreDocument(documents.find((d) => d.kind === 'image')!, { extract, reader });
    // The PDF's text layer reads with its Vietnamese diacritics; a reader that says "not an invoice" misses isInvoice.
    expect(seen[0]).toContain('Mực in laser');
    expect(seen[0]).toContain('1.815.000');
    expect(seen[1]).toBe('image/png true');
    expect(pdf).toMatchObject({ kind: 'pdf', error: null });
    expect(pdf.fields.find((f) => f.field === 'isInvoice')).toMatchObject({ match: false });
    expect(photo).toMatchObject({ kind: 'image', error: null });
  });

  it('needs the AI endpoint for a PDF or a photo', async () => {
    const pdf = documents.find((d) => d.kind === 'pdf')!;
    await expect(scoreDocument(pdf, { extract: inProcessExtract(), reader: null })).rejects.toThrow(/needs the AI endpoint/);
  });
});

describe('loadDocumentSet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crove-eval-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a document without its expected answer, and an answer without its document', () => {
    writeFileSync(join(dir, 'a.pdf'), '%PDF-1.4');
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ description: 'x', expected: null }));
    expect(() => loadDocumentSet(dir)).toThrow(/a: no a\.json next to the document[\s\S]*b\.json: no document with this name/);
  });
});
