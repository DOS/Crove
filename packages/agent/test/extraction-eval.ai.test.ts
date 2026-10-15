// Extraction eval (plan §8.7): runs the production extractor over the synthetic fixtures and fails when field
// accuracy drops below AI_EVAL_THRESHOLD (default 0.9) or a critical field (isInvoice, total) is wrong.
// Run with `pnpm ai:eval`; skipped without an endpoint. One test per fixture, so each gets its own time budget.
import { describe, expect, it } from 'vitest';
import { classifyAiError, formatEvalSummary, InvoiceExtractor, scoreExtraction, summarizeEval, type FixtureScore } from '../src/index.ts';
import { aiConfigFromEnv, loadExtractionFixtures, SKIP_NOTICE } from './support.ts';

const config = aiConfigFromEnv();
if (!config) console.warn(SKIP_NOTICE);

const rawThreshold = process.env.AI_EVAL_THRESHOLD?.trim() || '0.9';
const threshold = Number(rawThreshold);
if (!(threshold >= 0 && threshold <= 1)) throw new Error(`AI_EVAL_THRESHOLD must be a number from 0 to 1, got ${rawThreshold}`);

const fixtures = loadExtractionFixtures();

describe.skipIf(!config)('extraction eval', () => {
  const extractor = config ? new InvoiceExtractor(config) : null;
  const scores: FixtureScore[] = [];

  it.each(fixtures.map((f) => [f.id, f] as const))('extracts %s', async (_id, fixture) => {
    try {
      scores.push(scoreExtraction(fixture.id, fixture.expected, await extractor!.fromText(fixture.text)));
    } catch (error) {
      // An endpoint failure (HTTP error, timeout, network) says nothing about accuracy: fail instead of scoring it.
      if (classifyAiError(error).kind !== 'unknown') throw error;
      // A wrong answer the extractor refuses (an unreadable amount, output off the schema) scores zero.
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      scores.push(scoreExtraction(fixture.id, fixture.expected, undefined, message));
    }
  });

  it(`keeps field accuracy at or above ${threshold} with no critical miss`, () => {
    expect(scores.map((s) => s.id).sort(), 'every fixture must be scored').toEqual(fixtures.map((f) => f.id).sort());
    const summary = summarizeEval(scores, threshold);
    const report = formatEvalSummary(summary);
    console.log(report);
    expect(summary.passed, report).toBe(true);
  });
});
