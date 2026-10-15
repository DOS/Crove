// Shared by the AI suites: the endpoint from the environment and the synthetic extraction fixtures.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zExtractionFixture, type AiConfig, type ExpectedInvoice } from '../src/index.ts';

// The same variables the kernel reads. Without AI_BASE_URL and AI_MODEL the live suites are skipped.
export function aiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiConfig | null {
  const baseURL = env.AI_BASE_URL?.trim();
  const model = env.AI_MODEL?.trim();
  if (!baseURL || !model) return null;
  return {
    baseURL,
    apiKey: env.AI_API_KEY?.trim() || null,
    model,
    supportsStructuredOutputs: (env.AI_STRUCTURED_OUTPUTS ?? 'true') === 'true',
  };
}

export const SKIP_NOTICE = 'AI_BASE_URL and AI_MODEL are not set: skipping the live AI suite';

export interface ExtractionFixture {
  id: string;
  description: string;
  text: string;
  expected: ExpectedInvoice | null;
}

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'extraction');

// Each fixture is <id>.txt (the document text, as extracted from a PDF) plus <id>.json (the expected answer).
export function loadExtractionFixtures(): ExtractionFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const id = name.slice(0, -'.json'.length);
      const spec = zExtractionFixture.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')));
      return { id, description: spec.description, text: readFileSync(join(FIXTURE_DIR, `${id}.txt`), 'utf8'), expected: spec.expected };
    });
}
