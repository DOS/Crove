// Dependency rule (plan §5.4 "Allowed imports", gate G5): a few libraries belong to one package each. pg-boss runs
// the job queue in the kernel (apps/kernel); `ai` and `@ai-sdk/*` make AI calls only in packages/agent (AGENTS.md:
// "AI calls only in packages/agent"); `@orpc/server` serves the RPC routes only in apps/kernel (`@orpc/contract`,
// `@orpc/client` and `@orpc/tanstack-query` stay free); `@base-ui/*` is wrapped only by packages/ui. `@ai-sdk/gateway`
// (a hosted gateway that a string model id routes to) is used nowhere. A package's own tests are part of its home.
// String model ids (the other half of the §5.4 row) are checked in model-ids.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Every workspace package (pnpm-workspace.yaml: apps/*, packages/*, modules/*, e2e) and the repository tools.
const SCANNED = ['apps', 'modules', 'packages', 'e2e', 'tools'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.vite']);
// This file names every package in its fixtures.
const SELF = 'tools/test/allowed-imports.test.ts';

// A string literal holding exactly `name` or a path inside it (`name/sub/path`), in any quotes.
const literal = (name: string) => ['\'', '"', '`'].map((q) => `${q}(?:${name})(?:/[^${q}]*)?${q}`).join('|');

interface Rule {
  label: string;
  // The package names the rule covers, matched against manifest keys.
  manifest: RegExp;
  // A source that loads one of them.
  source: RegExp;
  // Path prefixes where the packages may be used; empty means nowhere.
  homes: string[];
}

const RULES: Rule[] = [
  {
    label: 'pg-boss',
    manifest: /^pg-boss$/,
    // Any string literal naming the package counts, whatever loads it: `import ... from`, `export ... from`, a
    // side-effect `import 'x'`, a dynamic `import('x')`, `require('x')`, `require.resolve('x')` or a
    // `createRequire(...)('x')`. A false alarm (the name in an ordinary string) is fixed by rewording.
    source: new RegExp(literal('pg-boss')),
    homes: ['apps/kernel/'],
  },
  {
    label: 'ai and @ai-sdk/*',
    manifest: /^(ai|@ai-sdk\/.+)$/,
    // `'ai'` alone is an ordinary word here (the AI kill switch key, a post's origin), so the bare name counts only
    // where code loads it: after `from` or `import`, inside `import(...)`, `require(...)` or `require.resolve(...)`,
    // or as the argument of a call result (`createRequire(...)('ai')`). A path inside it (`'ai/rsc'`) and any
    // `@ai-sdk/*` name count anywhere, like the other rules. Not caught: a createRequire result saved under a name
    // and called later with the bare `'ai'`.
    source: new RegExp(
      [
        `\\b(?:from|import)\\s*(?:${literal('ai')})`,
        `\\b(?:import|require|require\\.resolve)\\s*\\(\\s*(?:${literal('ai')})`,
        `\\)\\s*\\(\\s*(?:${literal('ai')})`,
        `'ai/[^']+'|"ai/[^"]+"|\`ai/[^\`]+\``,
        literal('@ai-sdk/[^\'"`/]+'),
      ].join('|'),
    ),
    homes: ['packages/agent/'],
  },
  {
    label: '@ai-sdk/gateway',
    manifest: /^@ai-sdk\/gateway$/,
    source: new RegExp(literal('@ai-sdk/gateway')),
    homes: [],
  },
  {
    label: '@orpc/server',
    manifest: /^@orpc\/server$/,
    source: new RegExp(literal('@orpc/server')),
    homes: ['apps/kernel/'],
  },
  {
    // The package is `@base-ui/react`; its earlier name `@base-ui-components/react` counts too.
    label: '@base-ui/*',
    manifest: /^@base-ui(-components)?\/.+$/,
    source: new RegExp(literal('@base-ui(?:-components)?/[^\'"`/]+')),
    homes: ['packages/ui/'],
  },
];

const inHome = (path: string, rule: Rule) => rule.homes.some((home) => path.startsWith(home));

// The rules a source at `path` (relative to the repository, with forward slashes) breaks.
function broken(path: string, text: string): string[] {
  return RULES.filter((rule) => !inHome(path, rule) && rule.source.test(text)).map((rule) => rule.label);
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name)) out.push(path);
  }
  return out;
}

const scanned = () =>
  SCANNED.flatMap((dir) => sources(join(ROOT, dir)))
    .map((path) => relative(ROOT, path).replace(/\\/g, '/'))
    .filter((path) => path !== SELF);

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

// The root manifest and every workspace package's, as directories relative to the repository ('' is the root).
function manifestDirs(): string[] {
  const dirs = [''];
  for (const parent of ['apps', 'packages', 'modules']) {
    for (const name of readdirSync(join(ROOT, parent))) {
      if (statSync(join(ROOT, parent, name)).isDirectory()) dirs.push(`${parent}/${name}`);
    }
  }
  dirs.push('e2e');
  return dirs.filter((dir) => {
    try {
      return statSync(join(ROOT, dir, 'package.json')).isFile();
    } catch {
      return false;
    }
  });
}

function listed(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as Manifest;
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies });
}

describe('allowed imports (plan §5.4, G5)', () => {
  it('no source outside its home loads pg-boss, ai, @ai-sdk/*, @orpc/server or @base-ui, and none loads @ai-sdk/gateway', () => {
    const offenders = scanned()
      .map((path) => ({ path, rules: broken(path, readFileSync(join(ROOT, path), 'utf8')) }))
      .filter(({ rules }) => rules.length > 0);
    expect(offenders).toEqual([]);
  });

  it('the scan finds the homes using them, so a broken walk cannot pass', () => {
    const paths = scanned();
    for (const path of ['apps/kernel/src/worker.ts', 'apps/kernel/src/rpc.ts', 'packages/agent/src/index.ts', 'packages/ui/src/components/button.tsx', 'tools/test/parser-imports.test.ts', 'e2e/playwright.config.ts']) {
      expect(paths, path).toContain(path);
    }
    const used = (path: string) => RULES.filter((rule) => rule.source.test(readFileSync(join(ROOT, path), 'utf8'))).map((rule) => rule.label);
    expect(used('apps/kernel/src/worker.ts')).toContain('pg-boss');
    expect(used('apps/kernel/src/rpc.ts')).toContain('@orpc/server');
    expect(used('packages/agent/src/index.ts')).toContain('ai and @ai-sdk/*');
    expect(used('packages/ui/src/components/button.tsx')).toContain('@base-ui/*');
  });

  it('the scan recognizes each import outside its home', () => {
    const cases: Array<[string, string, string]> = [
      ['pg-boss', 'modules/social/src/publisher.ts', "import { PgBoss } from 'pg-boss';"],
      ['pg-boss', 'packages/db/src/x.ts', 'const { PgBoss } = await import("pg-boss");'],
      ['pg-boss', 'tools/ops/x.mjs', "const boss = require('pg-boss');"],
      ['pg-boss', 'apps/app/src/x.ts', "export type { Job } from 'pg-boss/dist/types';"],
      ['ai and @ai-sdk/*', 'modules/finance/src/x.ts', "import { generateText } from 'ai';"],
      ['ai and @ai-sdk/*', 'packages/kernel/src/x.ts', 'import type { LanguageModel } from "ai";'],
      ['ai and @ai-sdk/*', 'apps/kernel/src/x.ts', "const { generateText } = await import( 'ai' );"],
      ['ai and @ai-sdk/*', 'apps/kernel/src/x.ts', "const ai = require('ai');"],
      ['ai and @ai-sdk/*', 'apps/kernel/src/x.ts', "const where = require.resolve('ai');"],
      ['ai and @ai-sdk/*', 'apps/kernel/src/x.ts', "const ai = createRequire(import.meta.url)('ai');"],
      ['ai and @ai-sdk/*', 'apps/kernel/src/x.ts', "import 'ai';"],
      ['ai and @ai-sdk/*', 'apps/kernel/src/x.ts', "export * from 'ai';"],
      ['ai and @ai-sdk/*', 'apps/kernel/src/x.ts', "import { x } from 'ai/rsc';"],
      ['ai and @ai-sdk/*', 'apps/kernel/src/x.ts', "const load = createRequire(import.meta.url);\nload('ai/test');"],
      ['ai and @ai-sdk/*', 'modules/social/src/x.ts', "import { createOpenAICompatible } from '@ai-sdk/openai-compatible';"],
      ['ai and @ai-sdk/*', 'modules/social/src/x.ts', 'const openai = await import(`@ai-sdk/openai`);'],
      ['@ai-sdk/gateway', 'packages/agent/src/x.ts', "import { gateway } from '@ai-sdk/gateway';"],
      ['@ai-sdk/gateway', 'apps/kernel/src/x.ts', "const g = require('@ai-sdk/gateway');"],
      ['@orpc/server', 'apps/app/src/x.ts', "import { implement } from '@orpc/server';"],
      ['@orpc/server', 'packages/kernel-contract/src/x.ts', "import { RPCHandler } from '@orpc/server/fetch';"],
      ['@base-ui/*', 'apps/app/src/x.tsx', 'import { Button } from "@base-ui/react/button"'],
      ['@base-ui/*', 'apps/web/src/x.tsx', "import { Dialog } from '@base-ui-components/react/dialog';"],
    ];
    for (const [label, path, line] of cases) {
      expect(broken(path, line), `${path}: ${line}`).toContain(label);
    }
  });

  it('the scan lets the homes, the free packages and the ordinary word "ai" through', () => {
    const cases: Array<[string, string]> = [
      // The homes, their tests included.
      ['apps/kernel/src/worker.ts', "import { PgBoss } from 'pg-boss';"],
      ['apps/kernel/test/jobs.db.test.ts', "import { PgBoss } from 'pg-boss';"],
      ['apps/kernel/src/rpc.ts', "import { RPCHandler } from '@orpc/server/fetch';"],
      ['packages/agent/src/index.ts', "import { generateText, Output } from 'ai';\nimport { createOpenAICompatible } from '@ai-sdk/openai-compatible';"],
      ['packages/agent/test/errors.test.ts', "import { APICallError } from 'ai';"],
      ['packages/ui/src/components/tabs.tsx', 'import { Tabs } from "@base-ui/react/tabs"'],
      // The oRPC contract, client and query bindings are free.
      ['apps/app/src/x.ts', "import { createORPCClient } from '@orpc/client';\nimport { oc } from '@orpc/contract';\nimport { createTanstackQueryUtils } from '@orpc/tanstack-query';"],
      // 'ai' as a value, a key or SQL text.
      ['modules/social/src/posts.ts', "origin: z.enum(['human', 'ai']).optional(),\ntainted: input.origin === 'ai',"],
      ['apps/app/src/x.tsx', "{row.ai && <Badge>{t('ai')}</Badge>}"],
      ['modules/finance/src/extract.ts', "sql`SELECT crove_kernel.global_kill_switch_on('ai') AS on`"],
      ['tools/ops/kill-switch.mjs', "const KEYS = ['ai', 'mail'];\nexpect(parseArgs(['ai', 'on'])).toEqual({ key: 'ai' });"],
      ['vitest.config.ts', "name: 'ai',"],
      // Look-alike names and prose.
      ['apps/app/src/x.ts', "import x from 'aiohttp';\nimport y from 'my-ai';\nimport z from 'pg-boss-extra';\nimport w from '@base-uix/react';"],
      ['modules/social/src/publisher.ts', '// the job throws, pg-boss retries it'],
    ];
    for (const [path, text] of cases) {
      expect(broken(path, text), `${path}: ${text}`).toEqual([]);
    }
  });

  it('only the home manifests list these packages, and none lists @ai-sdk/gateway', () => {
    const dirs = manifestDirs();
    for (const dir of ['', 'apps/kernel', 'apps/app', 'packages/agent', 'packages/ui', 'modules/social', 'e2e']) {
      expect(dirs, dir).toContain(dir);
    }
    const offenders = dirs.flatMap((dir) =>
      listed(dir)
        .flatMap((dep) => RULES.filter((rule) => rule.manifest.test(dep) && !inHome(`${dir}/`, rule)).map((rule) => `${dir || '(root)'}: ${dep} (${rule.label})`)),
    );
    expect(offenders).toEqual([]);
    // The homes do list them, so the check sees real manifests.
    expect(listed('apps/kernel')).toEqual(expect.arrayContaining(['pg-boss', '@orpc/server']));
    expect(listed('packages/agent')).toEqual(expect.arrayContaining(['ai', '@ai-sdk/openai-compatible']));
    expect(listed('packages/ui')).toEqual(expect.arrayContaining(['@base-ui/react']));
  });
});
