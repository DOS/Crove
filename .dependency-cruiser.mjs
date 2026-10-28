// dependency-cruiser (G5, plan §5.1, #1651): `pnpm depcruise`, a step of the `Lint, typecheck, test` CI job. The rules
// are generated (tools/depcruise-rules.mjs) from every module manifest's `dependsOn` and every workspace package's
// `exports`; an exception to a rule is listed there with its reason.
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXCEPTIONS, buildRules, readPackages } from './tools/depcruise-rules.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));

// The kernel's manifest and every module's: a directory under modules/ without one is a mistake.
const manifestFiles = [
  { dir: 'packages/kernel', file: './packages/kernel/src/manifest.ts' },
  ...readdirSync(new URL('./modules/', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: `modules/${d.name}`, file: `./modules/${d.name}/src/manifest.ts` })),
];
const modules = await Promise.all(
  manifestFiles.map(async ({ dir, file }) => {
    const manifests = Object.values(await import(file)).filter((v) => typeof v?.id === 'string' && Array.isArray(v.dependsOn));
    if (manifests.length !== 1) throw new Error(`depcruise: ${file} must export exactly one manifest with dependsOn`);
    return { id: manifests[0].id, dir, dependsOn: manifests[0].dependsOn };
  }),
);

// An exception for a file that is gone is stale: remove it.
for (const file of EXCEPTIONS.flatMap((e) => e.from)) {
  if (!existsSync(new URL(`./${file}`, import.meta.url))) throw new Error(`depcruise: an exception lists ${file}, which does not exist`);
}

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: buildRules(modules, readPackages(root)),
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|\\.next|coverage|test-results|playwright-report)/' },
    // Type-only imports are kept (and marked), so domain-pure can let them through and the others still see them.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.d.ts'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
