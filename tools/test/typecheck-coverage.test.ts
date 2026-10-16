// Every test directory is typechecked (issue #294). Vitest transpiles without checking types, so a test outside
// every tsconfig hides type errors (and syntax Node type stripping cannot run) until it misbehaves. Each workspace
// package with a test/ directory needs a tsconfig whose `include` lists it, run by its typecheck script, and
// tools/test is covered by tools/tsconfig.json from the root typecheck script.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

type Manifest = { name: string; scripts?: Record<string, string> };
type TsConfig = { extends?: string; include?: string[] };

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

// `include` is inherited through a relative `extends` and resolved against the file that declares it.
function includes(configPath: string): string[] {
  const config = readJson<TsConfig>(configPath);
  if (config.include) return config.include.map((entry) => relative(ROOT, join(dirname(configPath), entry)).replaceAll('\\', '/'));
  if (config.extends?.startsWith('.')) return includes(join(dirname(configPath), config.extends));
  return [];
}

const covers = (patterns: string[], testDir: string) =>
  patterns.some((pattern) => pattern === testDir || pattern.startsWith(`${testDir}/`) || testDir.startsWith(`${pattern}/`));

const hasTypeScript = (dir: string): boolean =>
  readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory() ? hasTypeScript(join(dir, entry.name)) : /\.tsx?$/.test(entry.name),
  );

const rootManifest = readJson<Manifest>(join(ROOT, 'package.json'));
const rootTypecheck = rootManifest.scripts?.typecheck ?? '';

const packages = ['apps', 'modules', 'packages'].flatMap((group) =>
  readdirSync(join(ROOT, group))
    .map((name) => `${group}/${name}`)
    .filter((dir) => existsSync(join(ROOT, dir, 'package.json'))),
);

// The tsconfig files a typecheck script runs, as paths from the repo root.
const configsRun = (script: string, cwd: string) =>
  [...script.matchAll(/(?:-p|--project)\s+(\S+)/g)].map((match) => relative(ROOT, join(ROOT, cwd, match[1] ?? '')).replaceAll('\\', '/'));

function uncovered(testDir: string, configs: string[]): boolean {
  return !configs.some((config) => existsSync(join(ROOT, config)) && covers(includes(join(ROOT, config)), testDir));
}

describe('typecheck coverage of tests', () => {
  it('every workspace package with TypeScript tests typechecks them', () => {
    const missing: string[] = [];
    for (const dir of packages) {
      const testDir = `${dir}/test`;
      if (!existsSync(join(ROOT, testDir)) || !hasTypeScript(join(ROOT, testDir))) continue;
      const manifest = readJson<Manifest>(join(ROOT, dir, 'package.json'));
      if (rootTypecheck.includes(`--filter=!${manifest.name}`)) missing.push(`${testDir} (package left out of pnpm typecheck)`);
      else if (uncovered(testDir, configsRun(manifest.scripts?.typecheck ?? '', dir))) missing.push(testDir);
    }
    expect(missing).toEqual([]);
  });

  it('the root typecheck covers tools/test', () => {
    expect(uncovered('tools/test', configsRun(rootTypecheck, '.'))).toBe(false);
  });

  it('the coverage check sees a test directory outside every include', () => {
    expect(covers(['packages/x/src'], 'packages/x/test')).toBe(false);
    expect(covers(['packages/x/src', 'packages/x/test'], 'packages/x/test')).toBe(true);
    expect(covers(['packages/x'], 'packages/x/test')).toBe(true);
    expect(configsRun('tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json', 'apps/app')).toEqual([
      'apps/app/tsconfig.json',
      'apps/app/tsconfig.test.json',
    ]);
  });
});
