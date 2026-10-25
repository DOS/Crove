// No string model ids (plan §5.4 "Allowed imports", gate G5): which model answers is deployment configuration
// (AI_MODEL, with AI_BASE_URL an OpenAI-compatible endpoint, AGENTS.md), never a literal in the source, so a deployment
// can switch models without a code change and no code path silently pins a vendor. Tests may name a model in their
// fixtures; product sources may not. `allowed-imports.test.ts` covers the other half of the row (the packages).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED = ['apps', 'modules', 'packages', 'tools'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.vite', 'test', 'tests', 'e2e']);

// A string literal (any quotes) holding a model id of a known family, with or without a provider prefix
// (`openai/gpt-4o`, `anthropic/claude-...`). Families are matched by their versioned names, so ordinary words
// ("Claude", "llama" in a sentence) do not count. A false alarm is fixed by rewording.
const FAMILY =
  '(?:gpt-[0-9]|chatgpt-|o[1-9](?:-mini|-pro|-preview)\\b|claude-[0-9a-z]|gemini-[0-9]|gemma-?[0-9]|qwen-?[0-9]|qwq-|llama-?[0-9]|' +
  'mistral-(?:large|medium|small|tiny|nemo)|mixtral-|codestral-|deepseek-(?:chat|coder|reasoner|v[0-9]|r[0-9])|grok-[0-9]|command-r|phi-[0-9])';
const MODEL_ID = new RegExp(`(['"\`])(?:[a-z0-9_.-]+/)?${FAMILY}[^'"\`\\s]*\\1`, 'i');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('string model ids (plan §5.4, G5)', () => {
  it('finds model ids of every family, with or without a provider prefix, and not ordinary words', () => {
    for (const id of ['gpt-4o', 'gpt-5.1-mini', 'o3-mini', 'claude-opus-5-5', 'anthropic/claude-sonnet-4', 'gemini-2.5-pro', 'qwen3-32b', 'Qwen/Qwen3-8B', 'llama-3.1-70b', 'deepseek-chat', 'grok-4', 'mistral-large-latest']) {
      expect(MODEL_ID.test(`const m = '${id}';`), id).toBe(true);
      expect(MODEL_ID.test(`model: "${id}"`), id).toBe(true);
    }
    for (const text of ["'Claude'", "'gpt'", "'o1'", "'qwen'", "'Mô hình AI'", "'ai'", "'llama của tôi'", "'o3'"]) {
      expect(MODEL_ID.test(text), text).toBe(false);
    }
  });

  it('keeps model ids out of every product source', () => {
    const offenders: string[] = [];
    for (const top of SCANNED) {
      for (const file of sources(join(ROOT, top))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (MODEL_ID.test(line)) offenders.push(`${relative(ROOT, file).replaceAll('\\', '/')}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
