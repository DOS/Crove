// How the extraction job maps crove-extract answers (External-tenant gate T12): failures caused by the file are
// recorded on the file and never retried; a sandbox that cannot answer throws, so the job is retried.
import { describe, expect, it } from 'vitest';
import { ExtractServiceError, type ExtractClient, type ExtractResponse } from '@crove/extract-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { AI_STOPPED_MESSAGE, extractAndPropose } from '../src/extract.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const FILE = '00000000-0000-4000-8000-000000000002';
const BYTES = new TextEncoder().encode('<HDon/>');
const SHA256 = sha256Hex(BYTES);

function harness(answer: () => Promise<ExtractResponse>, file: { filename: string; content_type: string; aiStopped?: boolean } = { filename: 'hd.xml', content_type: 'application/xml' }) {
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const asked: string[] = [];
  const runtime = {
    query: async (name: string) => {
      if (name === 'finance.extraction.file') return { id: FILE, ...file, storage_key: `org/${ORG}/${SHA256}`, generation: `content:${SHA256}`, sha256: SHA256, hasExtraction: false, due: true };
      return { vendorDefault: null, duplicateDocumentId: null, duplicateProposalId: null };
    },
    execute: async (name: string, input: Record<string, unknown>) => {
      executed.push({ name, input });
      return { proposalId: null };
    },
  } as unknown as Runtime;
  const store = { get: async () => BYTES } as unknown as BlobStore;
  const extract: ExtractClient = {
    extract: async (kind) => {
      asked.push(kind);
      return answer() as never;
    },
  };
  return { deps: { runtime, store, extractor: null, extract, today: () => '2026-10-13' }, executed, asked };
}

describe('extraction through crove-extract', () => {
  it('records the reason when the sandbox finds the file invalid, without parsing it in the worker', async () => {
    const { deps, executed, asked } = harness(async () => ({ ok: false, code: 'invalid', message: 'XML chứa DOCTYPE/ENTITY, bị từ chối' }));
    await extractAndPropose(deps, ORG, FILE);
    expect(asked).toEqual(['einvoice_xml']);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      name: 'kernel.extraction.record',
      input: { fileId: FILE, method: 'einvoice_xml', status: 'failed', error: 'XML chứa DOCTYPE/ENTITY, bị từ chối', proposal: null },
    });
  });

  it('records limit failures with its own message', async () => {
    for (const [code, message] of [
      ['timeout', 'Đọc tệp quá lâu nên đã dừng; hãy kiểm tra lại tệp'],
      ['memory', 'Tệp quá phức tạp để đọc; hãy kiểm tra lại tệp'],
      ['too_large', 'Tệp quá lớn để đọc (tối đa 25 MB)'],
    ] as const) {
      const { deps, executed } = harness(async () => ({ ok: false, code, message: 'from the sandbox' }));
      await extractAndPropose(deps, ORG, FILE);
      expect(executed[0]?.input).toMatchObject({ status: 'failed', error: message });
    }
  });

  it('throws when the sandbox cannot answer, so the job retries and nothing is recorded', async () => {
    const { deps, executed } = harness(async () => {
      throw new ExtractServiceError('malformed', 'crove-extract answer failed validation (200)');
    });
    await expect(extractAndPropose(deps, ORG, FILE)).rejects.toBeInstanceOf(ExtractServiceError);
    expect(executed).toHaveLength(0);
  });

  it('fails without a sandbox client, under the test runner too, instead of parsing in the worker', async () => {
    const { deps, executed } = harness(async () => ({ ok: false, code: 'invalid', message: 'x' }));
    const { extract: _unused, ...withoutClient } = deps;
    for (const nodeEnv of ['test', 'production']) {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = nodeEnv;
      try {
        await expect(extractAndPropose(withoutClient as typeof deps, ORG, FILE)).rejects.toThrow(/crove-extract client/);
      } finally {
        process.env.NODE_ENV = previous;
      }
    }
    expect(executed).toHaveLength(0);
  });

  it('does not call the sandbox for a PDF when AI is not configured', async () => {
    const { deps, executed, asked } = harness(async () => ({ ok: true, kind: 'pdf_text', text: 'x', pages: 1 }), {
      filename: 'hd.pdf',
      content_type: 'application/pdf',
    });
    await extractAndPropose(deps, ORG, FILE);
    expect(asked).toEqual([]);
    expect(executed[0]?.input).toMatchObject({ status: 'failed', error: expect.stringMatching(/Chưa cấu hình AI/) });
  });

  // #886: "Dừng AI" for the org (or the finance module) stops the AI reads; XML needs no AI and goes on.
  it('reads no PDF or photo with AI while AI is stopped, and still parses XML', async () => {
    const read: string[] = [];
    const extractor = {
      fromText: async () => {
        read.push('text');
        return null;
      },
      fromImage: async () => {
        read.push('image');
        return null;
      },
    };
    for (const file of [
      { filename: 'hd.pdf', content_type: 'application/pdf', aiStopped: true },
      { filename: 'hd.png', content_type: 'image/png', aiStopped: true },
    ]) {
      const { deps, executed, asked } = harness(async () => ({ ok: true, kind: 'pdf_text', text: 'x'.repeat(100), pages: 1 }), file);
      await extractAndPropose({ ...deps, extractor: extractor as never }, ORG, FILE);
      expect(asked, file.filename).toEqual([]);
      expect(executed[0]?.input, file.filename).toMatchObject({ status: 'failed', error: AI_STOPPED_MESSAGE, proposal: null });
    }
    expect(read).toEqual([]);
    const xml = harness(async () => ({ ok: false, code: 'invalid', message: 'x' }), { filename: 'hd.xml', content_type: 'application/xml', aiStopped: true });
    await extractAndPropose(xml.deps, ORG, FILE);
    expect(xml.asked).toEqual(['einvoice_xml']);
  });
});
