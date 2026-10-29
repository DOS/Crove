// The dependency-cruiser rules (G5, plan §5.1, #1651), generated from the module manifests' `dependsOn` and the
// workspace packages' `exports`. .dependency-cruiser.mjs reads both from the tree and passes them here, so a new
// module, a new dependency or a new export changes the rules with no edit to this file.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every workspace package (pnpm-workspace.yaml: apps/*, packages/*, modules/*, e2e): its directory, name and the
// files its `exports` point to.
export function readPackages(root) {
  const dirs = ['e2e'];
  for (const parent of ['apps', 'packages', 'modules']) {
    for (const d of readdirSync(join(root, parent), { withFileTypes: true })) if (d.isDirectory()) dirs.push(`${parent}/${d.name}`);
  }
  return dirs
    .filter((dir) => existsSync(join(root, dir, 'package.json')))
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
      return { dir, name: pkg.name, exports: exportTargets(pkg.exports) };
    });
}

// The files an `exports` field points to, condition objects included; `*` in a target stays a wildcard, and a null
// target (a path the package forbids) points nowhere.
function exportTargets(exports) {
  if (typeof exports === 'string') return [exports];
  if (exports === null || typeof exports !== 'object') return [];
  return Object.values(exports).flatMap(exportTargets);
}

// A module manifest's `dependsOn` must name modules that exist, and the modules must form a DAG; anything else is a
// mistake in a manifest, refused before any rule is made.
export function checkModuleGraph(modules) {
  const ids = new Set(modules.map((m) => m.id));
  if (ids.size !== modules.length) throw new Error('depcruise: two manifests share a module id');
  for (const m of modules) {
    for (const dep of m.dependsOn) {
      if (!ids.has(dep)) throw new Error(`depcruise: the ${m.id} manifest depends on ${dep}, which is no module`);
      if (dep === m.id) throw new Error(`depcruise: the ${m.id} manifest depends on itself`);
    }
    if (m.dependsOn.join() !== [...new Set(m.dependsOn)].sort().join()) throw new Error(`depcruise: the ${m.id} manifest's dependsOn is not sorted or repeats a module`);
  }
  const byId = new Map(modules.map((m) => [m.id, m]));
  const done = new Set();
  const visit = (id, path) => {
    if (path.includes(id)) throw new Error(`depcruise: the manifests' dependsOn form a cycle: ${[...path, id].join(' -> ')}`);
    if (done.has(id)) return;
    for (const dep of byId.get(id).dependsOn) visit(dep, [...path, id]);
    done.add(id);
  };
  for (const m of modules) visit(m.id, []);
}

// An import a rule refuses that stays, each with its reason: the rule lets the listed files (exact paths, no
// patterns, so an exception never grows by itself) import what `to` (a path regex) matches.
export const EXCEPTIONS = [
  {
    rule: 'domain-pure',
    from: ['modules/social/src/domain/publish.ts'],
    to: '^packages/channel/src/',
    reason:
      'An `import type` of RetrySafety, the retry contract every channel adapter declares: a top-level `import type` is erased, so nothing of @crove/channel loads.',
  },
  {
    rule: 'no-deep-import',
    from: [
      'apps/kernel/test/archive.db.test.ts',
      'apps/kernel/test/finance-late-invoice.db.test.ts',
      'apps/kernel/test/finance-missing-invoices.db.test.ts',
      'apps/kernel/test/finance-portal-list.db.test.ts',
      'apps/kernel/test/http.test.ts',
      'apps/kernel/test/portal-sync.db.test.ts',
      'apps/kernel/test/tax-portal.test.ts',
      'e2e/tests/bulk-intake.spec.ts',
    ],
    to: '^(apps/extract/test/(zip|xlsx)-fixture\\.ts|e2e/fake-tax-portal/server\\.ts)$',
    reason:
      'Test fixtures shared by the tests of several packages: the zip and xlsx builders of apps/extract and the fake tax portal of e2e. Test code that never ships; copies would drift.',
  },
  {
    rule: 'no-deep-import',
    from: ['apps/kernel/test/command-labels.test.ts', 'apps/kernel/test/social-plan-export.db.test.ts'],
    to: '^apps/app/src/(lib/(audit|social-import|bank-statement)|i18n/messages/(vi|en))\\.ts$',
    reason:
      "Cross-checks between the server and the app: every command has a label in both languages, and the plan CSV and the bank statement the app parses are the files the server writes. They need the app's own files; tests only.",
  },
  {
    rule: 'no-deep-import',
    from: ['e2e/tests/auth-signup-parity.spec.ts'],
    to: '^apps/kernel/src/auth-signup-policy\\.ts$',
    reason: "The end-to-end check that the sign-up page and the server apply the same password and email policy reads the server's policy; a test only.",
  },
];

/** @typedef {{ name: string, comment: string, severity: 'error', from: Record<string, any>, to: Record<string, any> }} Rule */

// The rules.
//   modules: [{ id, dir, dependsOn }], the kernel's manifest included (dir packages/kernel).
//   packages: readPackages().
/** @returns {Rule[]} */
export function buildRules(modules, packages, exceptions = EXCEPTIONS) {
  checkModuleGraph(modules);
  const moduleDirs = new Set(modules.map((m) => m.dir));
  const rules = [];

  // A module imports only the modules its manifest lists (plan §5.1: modules talk only through the public API, and
  // the graph is a DAG). One rule per module that has modules it must not import.
  for (const m of modules) {
    const others = modules.filter((o) => o.id !== m.id && !m.dependsOn.includes(o.id));
    if (others.length === 0) continue;
    rules.push({
      name: `module-dag-${m.id}`,
      comment: `The ${m.id} manifest's dependsOn is [${m.dependsOn.join(', ')}]: ${m.dir} imports none of ${others.map((o) => o.id).join(', ')}. Add the module to dependsOn (keeping the graph a DAG) or move the shared code down.`,
      severity: 'error',
      from: { path: `^${escape(m.dir)}/` },
      to: { path: `^(${others.map((o) => escape(o.dir)).join('|')})/` },
    });
  }

  // The platform packages sit under every module: none of them imports a module, the kernel module included.
  const platform = packages.filter((p) => p.dir.startsWith('packages/') && !moduleDirs.has(p.dir));
  rules.push({
    name: 'platform-imports-no-module',
    comment: `A platform package (${platform.map((p) => p.name).join(', ')}) imports no module: modules depend on the platform, never the other way.`,
    severity: 'error',
    from: { path: `^(${platform.map((p) => escape(p.dir)).join('|')})/` },
    to: { path: `^(${[...moduleDirs].map(escape).join('|')})/` },
  });

  // No deep imports (plan §5.1): another package's files are reached only through its `exports`. A package with no
  // `exports` (an app, e2e) is imported by nobody. A specifier past `exports` does not resolve at all, which the
  // second rule names; nor does a package the importer's package.json does not list (pnpm links only declared
  // dependencies), which the third names.
  const exported = packages.flatMap((p) => p.exports.map((t) => `^${escape(p.dir)}/${escape(t.replace(/^\.\//, '')).replace(/\\\*/g, '.+')}$`));
  rules.push({
    name: 'no-deep-import',
    comment: 'A file of another workspace package is imported only through that package\'s exports (its package.json), never by a relative path or a path past them.',
    severity: 'error',
    from: { path: '^((?:apps|packages|modules)/[^/]+|e2e)/' },
    to: { path: '^((?:apps|packages|modules)/[^/]+|e2e)/', pathNot: ['^$1/', ...exported] },
  });
  rules.push({
    name: 'no-deep-import',
    comment: 'A @crove/<package>/<path> specifier that does not resolve: a path past the package\'s exports (or a package the importer does not list). Import what the package exports.',
    severity: 'error',
    from: {},
    to: { couldNotResolve: true, path: '^@crove/[^/]+/' },
  });
  rules.push({
    name: 'workspace-dependency-declared',
    comment: 'A @crove/* package imported without being in the importer\'s package.json (pnpm links only declared dependencies). List it there; for a module, in the manifest\'s dependsOn too.',
    severity: 'error',
    from: {},
    to: { couldNotResolve: true, path: '^@crove/[^/]+$' },
  });

  // Any other import that does not resolve (a misspelt package or a missing file in a .mjs or .js file, which no
  // typecheck reads).
  rules.push({
    name: 'resolvable',
    comment: 'An import that does not resolve to a file: a misspelt package or path, or a package the importer does not list.',
    severity: 'error',
    from: {},
    to: { couldNotResolve: true, pathNot: '^@crove/' },
  });

  // domain/ stays pure (plan §5.1): aggregates, invariants, state machines and decimal math, with no database, React
  // or network. It imports its own module's domain/, the isomorphic packages, zod, decimal.js and node:crypto. A
  // type-only import is no exemption: dependency-cruiser marks `import { type X } from 'm'` type-only too, and under
  // verbatimModuleSyntax Node still loads `m` for it, so one stays only as an exception.
  rules.push({
    name: 'domain-pure',
    comment: 'A domain/ file imports only its own domain/, @crove/kernel-contract, @crove/extract-contract, @crove/l10n-vn, zod, decimal.js and node:crypto: no database, runtime, React or network.',
    severity: 'error',
    from: { path: '^(modules/[^/]+)/src/domain/' },
    to: {
      pathNot: ['^$1/src/domain/', '^packages/(kernel-contract|extract-contract|l10n-vn)/src/', '(^|/)node_modules/(zod|decimal\\.js)/', '^(node:)?crypto$'],
    },
  });

  // The app (the browser shell) reaches none of the server: not the database, the command runtime or the kernel, not
  // even through a module's contract. It imports a module only through that module's `./contract` export, the
  // isomorphic part the plan gives every module (§5.1): the Social composer checks a post as it is typed with the
  // rules the commands apply, so @crove/app depends on @crove/mod-social for its contract and nothing else.
  rules.push({
    name: 'app-no-server',
    comment: 'apps/app reaches none of @crove/db, @crove/kernel-runtime or @crove/kernel, directly or through another file.',
    severity: 'error',
    from: { path: '^apps/app/' },
    // Their entry files: every other file of theirs is reached through one, so one line names each package reached.
    to: { path: '^packages/(db|kernel-runtime|kernel)/src/(index|migrate)\\.ts$', reachable: true },
  });
  rules.push({
    name: 'app-module-contract-only',
    comment: 'apps/app imports a module only through its ./contract export (the isomorphic part), never its server entry.',
    severity: 'error',
    from: { path: '^apps/app/' },
    to: { path: `^(${[...moduleDirs].map(escape).join('|')})/`, pathNot: '^modules/[^/]+/src/contract\\.ts$' },
  });

  return applyExceptions(rules, exceptions);
}

// The exceptions exempt files from rules: a rule no longer applies to a file some exception lists, and a copy of it,
// under the same name, applies to that file alone with every `to` of the file's exceptions added to its `to.pathNot`.
// The copy's `from.path` captures the file's package directory, the `$1` the rules' `to.pathNot` refer to.
function applyExceptions(rules, exceptions) {
  for (const e of exceptions) {
    if (!e.reason) throw new Error(`depcruise: an exception to ${e.rule} has no reason`);
    if (!rules.some((r) => r.name === e.rule)) throw new Error(`depcruise: an exception names ${e.rule}, which is no rule`);
  }
  const list = (v) => (v === undefined ? [] : [v].flat());
  return rules.flatMap((rule) => {
    const own = exceptions.filter((e) => e.rule === rule.name);
    if (own.length === 0) return [rule];
    const files = [...new Set(own.flatMap((e) => e.from))].sort();
    // The copy takes the file as its `from.path`, so a file the rule does not cover would widen the rule to it.
    const covered = rule.from.path === undefined ? null : new RegExp(rule.from.path);
    const outside = covered && files.find((f) => !covered.test(f));
    if (outside) throw new Error(`depcruise: an exception to ${rule.name} lists ${outside}, which the rule does not cover`);
    const base = { ...rule, from: { ...rule.from, pathNot: [...list(rule.from.pathNot), ...files.map((f) => `^${escape(f)}$`)] } };
    const exempt = files.map((file) => {
      const dir = file.startsWith('e2e/') ? 'e2e' : file.split('/').slice(0, 2).join('/');
      const mine = own.filter((e) => e.from.includes(file));
      return {
        ...rule,
        comment: `${rule.comment} Exception: ${mine.map((e) => e.reason).join(' ')}`,
        from: { ...rule.from, path: `^(${escape(dir)})${escape(file.slice(dir.length))}$` },
        to: { ...rule.to, pathNot: [...list(rule.to.pathNot), ...mine.map((e) => e.to)] },
      };
    });
    return [base, ...exempt];
  });
}
