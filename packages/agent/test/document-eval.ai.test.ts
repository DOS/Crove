// Document eval (#687, plan M2-11): reads every document of a set through its production path and reports accuracy
// per kind and per field and the top errors. The gate: every amount of every XML document exact; PDF and photo
// accuracy is measured. The set is AI_EVAL_DIR (the private documents, kept outside the repository; see
// docs/runbooks/ai-eval.md) or, without it, the committed synthetic set. Run with `pnpm ai:eval:documents`.
// Without an endpoint (AI_BASE_URL, AI_MODEL) only the XML documents run: they need no AI.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatDocumentEvalReport, InvoiceExtractor, summarizeDocumentEval, type DocumentScore } from '../src/index.ts';
import { inProcessExtract, loadDocumentSet, scoreDocument, SYNTHETIC_DOCUMENTS } from './documents.ts';
import { aiConfigFromEnv, SKIP_NOTICE } from './support.ts';

const privateDir = process.env.AI_EVAL_DIR?.trim() || null;
const documents = loadDocumentSet(privateDir ?? SYNTHETIC_DOCUMENTS);
const config = aiConfigFromEnv();
if (!config) console.warn(`${SKIP_NOTICE} (the XML documents still run)`);
// Values of a wrong field are printed only for the committed synthetic set, never for the private documents.
const showValues = privateDir === null || process.env.AI_EVAL_SHOW_VALUES === 'true';

describe('document eval', () => {
  const extract = inProcessExtract();
  const reader = config ? new InvoiceExtractor(config) : null;
  const scores: DocumentScore[] = [];
  const run = documents.filter((d) => d.kind === 'xml' || reader);

  for (const document of documents) {
    it.skipIf(!run.includes(document))(`reads ${document.id} (${document.kind})`, async () => {
      scores.push(await scoreDocument(document, { extract, reader }));
    });
  }

  it('gets every XML amount exact, and reports accuracy per kind and per field', () => {
    expect(scores.map((s) => s.id).sort(), 'every document must be scored').toEqual(run.map((d) => d.id).sort());
    const summary = summarizeDocumentEval(scores);
    const report = formatDocumentEvalReport(summary, { showValues });
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    expect(summary.passed, report).toBe(true);
  });
});
