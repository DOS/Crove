// Extraction eval (plan §8.7): runs the production extractor over the synthetic fixtures and fails when field
// accuracy drops below AI_EVAL_THRESHOLD (default 0.9). Run with `pnpm ai:eval`; skipped without an endpoint.
import { describe, expect, it } from 'vitest';
import { classifyAiError, formatEvalSummary, InvoiceExtractor, scoreExtraction, summarizeEval, type FixtureScore } from '../src/index.ts';
import { aiConfigFromEnv, loadExtractionFixtures, SKIP_NOTICE } from './support.ts';

const config = aiConfigFromEnv();
if (!config) console.warn(SKIP_NOTICE);

const threshold = Number(process.env.AI_EVAL_THRESHOLD ?? '0.9');
if (!(threshold >= 0 && threshold <= 1)) throw new Error(`AI_EVAL_THRESHOLD must be a number from 0 to 1, got ${process.env.AI_EVAL_THRESHOLD}`);

describe.skipIf(!config)('extraction eval', () => {
  it(`keeps field accuracy at or above ${threshold}`, async () => {
    const extractor = new InvoiceExtractor(config!);
    const scores: FixtureScore[] = [];
    for (const fixture of loadExtractionFixtures()) {
      try {
        scores.push(scoreExtraction(fixture.id, fixture.expected, await extractor.fromText(fixture.text)));
      } catch (error) {
        // An endpoint failure (HTTP error, timeout, network) says nothing about accuracy: stop instead of scoring it.
        if (classifyAiError(error).kind !== 'unknown') throw error;
        // A wrong answer the extractor refuses (an unreadable amount, output off the schema) scores zero.
        scores.push(scoreExtraction(fixture.id, fixture.expected, undefined, error instanceof Error ? `${error.name}: ${error.message}` : String(error)));
      }
    }
    const summary = summarizeEval(scores, threshold);
    const report = formatEvalSummary(summary);
    console.log(report);
    expect(summary.accuracy, report).toBeGreaterThanOrEqual(threshold);
  });
});
