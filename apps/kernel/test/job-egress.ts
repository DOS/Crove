// What each job queue reaches over the network, read from the kernel's source (plan §4.6 `defineJob`, §4.7 "Derived
// risk", §7.7, #1653). job-egress.test.ts feeds these the real sources, and planted ones that must fail. The sources
// are parsed by Vite's parser (an ESTree with TypeScript nodes); names are resolved by lexical scope.
//
// - workSites(): every boss.work() of the worker, with what its handler reaches: everything its code refers to,
//   followed through the worker's own declarations and the kernel's own files (apps/kernel/src), and every WorkerDeps
//   field it uses. The egress guard of @crove/kernel-runtime reaches a tenant's URL; the readers and writers of
//   @crove/agent and the invoice reader reach provider:ai; what @crove/channel exports beyond its pure helpers, the
//   publishers and the mailer reach their provider; fetch() itself and Node's network modules are never allowed.
// - sendSites(): every boss.send() and boss.schedule() of apps/kernel/src, with the queues it may name and, inside the
//   outbox relay, the outbox events that lead to it.
// - emittersOf(): the commands whose handler emits an event, followed through the helpers they call and through the
//   nested commands they run (ctx.run and ctx.tryRun), transitively.
//
// Modules and packages/kernel never reach the network themselves (commands do no network I/O, plan §4.6): the test
// runs reachOf() over each of their files and finds nothing, so following the worker into them finds nothing either.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseAst } from 'vitest/node';

const ROOT = resolve(import.meta.dirname, '../../..');
const KERNEL_SRC = 'apps/kernel/src';

// An ESTree node.
type N = { type: string; start: number; end: number; [key: string]: any };

// What a handler reaches: an egress target as QUEUE_EGRESS names it, 'publishers' (the channel adapters: the publish
// queue's provider, or provider:channel, and the guard for the hosts a tenant names), or 'raw_network' (fetch() or a
// Node network module, never allowed).
export type Reach = 'tenant_url' | `provider:${string}` | 'publishers' | 'raw_network';

// The egress guard (packages/kernel-runtime/src/egress.ts).
const GUARDS: ReadonlySet<string> = new Set(['guardedFetch', 'guardedRequest', 'egressFetch']);
// What @crove/channel exports that reaches no platform: its constants, its errors and these helpers. Anything else
// (publishers, connectors, refreshers, logins, checks, send helpers) reaches one: Telegram or Discord when it names
// them, provider:channel otherwise.
const CHANNEL_PURE: ReadonlySet<string> = new Set(['capOptions', 'discordChatTargetOf', 'isChannelProvider', 'newOAuthAttempt', 'oauthStateHash', 'postTypeOf', 'sandbox', 'telegramChatTargetOf', 'withCallSignal']);
const channelReach = (name: string): Reach | null =>
  /^[A-Z][A-Z0-9_]*$/.test(name) || name.endsWith('Error') || CHANNEL_PURE.has(name) ? null : /telegram/i.test(name) ? 'provider:telegram' : /discord/i.test(name) ? 'provider:discord' : 'provider:channel';
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'global', 'window', 'self']);
// Node's own network modules: a job reaches the network only through the guard or an adapter.
const NETWORK_MODULES = /^(node:)?(http|https|http2|net|tls|dgram|dns)$|^undici$/;
// What calls the AI endpoint in @crove/agent: its model and the readers and writers built on it.
const AI_EXPORT = /^chatModel$|^[A-Z]\w*(Extractor|Reader|Writer)$/;

// Every field of WorkerDeps (a dotted path for a field inside one) and what using it reaches. A field the test does
// not know fails it, so a new network dependency of the worker is classified before it is used. Empty: a service of the
// stack itself (QUEUE_EGRESS in jobs-schema.ts says which).
export const DEPS_REACH: Readonly<Record<string, readonly Reach[]>> = {
  connectionString: [],
  workerDb: [],
  runtime: [],
  store: [],
  // The invoice reader of packages/agent.
  extractor: ['provider:ai'],
  extract: [],
  inboundDomain: [],
  // Supabase Auth.
  revoker: [],
  instance: [],
  refusalTallyRetentionDays: [],
  agentPrograms: [],
  exportSealer: [],
  exportRetentionDays: [],
  evidenceLockDays: [],
  channels: ['publishers', 'provider:channel'],
  'channels.broker': [],
  'channels.publishers': ['publishers'],
  'channels.refreshers': ['provider:channel'],
  publicUrl: [],
  brand: [],
  mail: ['provider:mail'],
  push: ['tenant_url'],
  'push.brand': [],
  archive: [],
  usageLimits: [],
  // The operator's alert webhook.
  securityAlerts: ['provider:alert'],
  'securityAlerts.thresholds': [],
  aiPrice: [],
  outboxLagPauseSeconds: [],
};

interface Site {
  file: string;
  line: number;
}

export interface WorkSite extends Site {
  queues: readonly string[];
  reaches: ReadonlySet<Reach>;
}

interface SendSite extends Site {
  queues: readonly string[];
  // The outbox events that lead to it, inside the relay; null outside it, or when the test cannot read its condition.
  events: readonly string[] | null;
  // 'the outbox relay', '<queue> handler' inside a boss.work() handler, or the function it is in.
  within: string;
}

interface Source {
  path: string;
  text: string;
  program: N;
}

const parents = new WeakMap<N, N>();
const sourceOf = new WeakMap<N, Source>();
const isNode = (v: unknown): v is N => typeof v === 'object' && v !== null && typeof (v as N).type === 'string';

// The children of a node, every key but its position.
function children(node: N): N[] {
  const out: N[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'type') continue;
    if (Array.isArray(value)) for (const v of value) if (isNode(v)) out.push(v);
    if (isNode(value)) out.push(value);
  }
  return out;
}

function each(node: N, fn: (n: N) => void): void {
  fn(node);
  for (const child of children(node)) each(child, fn);
}

// The sources read, by path from the repository root; `overrides` replaces a file's text (planted sources).
export class Sources {
  readonly #files = new Map<string, Source>();
  readonly overrides: Readonly<Record<string, string>>;
  constructor(overrides: Readonly<Record<string, string>> = {}) {
    this.overrides = overrides;
  }

  get(path: string): Source {
    let file = this.#files.get(path);
    if (!file) {
      const text = this.overrides[path] ?? readFileSync(join(ROOT, path), 'utf8');
      const program = parseAst(text, { lang: 'ts' } as never) as unknown as N;
      file = { path, text, program };
      const link = (node: N) => {
        sourceOf.set(node, file as Source);
        for (const child of children(node)) {
          parents.set(child, node);
          link(child);
        }
      };
      link(program);
      this.#files.set(path, file);
    }
    return file;
  }

  // Every .ts source under the directories, tests aside, planted ones included.
  list(dirs: readonly string[]): string[] {
    const out = new Set<string>();
    const source = (name: string) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'test' && entry.name !== 'dist') walk(path);
        } else if (source(entry.name)) out.add(path);
      }
    };
    for (const dir of dirs) {
      if (existsSync(join(ROOT, dir))) walk(dir);
      for (const path of Object.keys(this.overrides)) if (path.startsWith(`${dir}/`) && source(path)) out.add(path);
    }
    return [...out].sort();
  }
}

const parentOf = (node: N): N | undefined => parents.get(node);
const fileOf = (node: N): string => sourceOf.get(node)?.path ?? '?';
const textOf = (node: N): string => sourceOf.get(node)?.text.slice(node.start, node.end) ?? '?';
function lineOf(node: N): number {
  const text = sourceOf.get(node)?.text ?? '';
  let line = 1;
  for (let i = 0; i < node.start; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
const at = (node: N) => `${fileOf(node)}:${lineOf(node)}`;

const isFunction = (n: N) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

// The identifiers a binding pattern declares, with the node each one maps to.
function patternNames(pattern: N | null, out: N[] = []): N[] {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push(pattern);
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, out);
  else if (pattern.type === 'ArrayPattern') for (const e of pattern.elements) patternNames(e, out);
  else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) patternNames(p.type === 'RestElement' ? p : p.value, out);
  else if (pattern.type === 'TSParameterProperty') patternNames(pattern.parameter, out);
  return out;
}

// A declaration: a VariableDeclarator, a parameter's identifier, a function or class declaration, or an import
// specifier.
type Declaration = N;
const scopes = new WeakMap<N, Map<string, Declaration>>();

// The declarations a scope introduces, by name.
function scopeDeclarations(scope: N): Map<string, Declaration> {
  const cached = scopes.get(scope);
  if (cached) return cached;
  const out = new Map<string, Declaration>();
  const addVariables = (decl: N) => {
    for (const d of decl.declarations as N[]) for (const id of patternNames(d.id)) out.set(id.name, d);
  };
  const statements: N[] | null =
    scope.type === 'Program' || scope.type === 'BlockStatement' || scope.type === 'StaticBlock' ? scope.body : scope.type === 'SwitchCase' ? scope.consequent : null;
  for (const raw of statements ?? []) {
    const s: N = (raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration') && raw.declaration ? raw.declaration : raw;
    if (s.type === 'VariableDeclaration') addVariables(s);
    else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) out.set(s.id.name, s);
    else if (s.type === 'ImportDeclaration' && s.importKind !== 'type') {
      for (const spec of s.specifiers as N[]) if (spec.importKind !== 'type') out.set(spec.local.name, spec);
    }
  }
  if (isFunction(scope)) {
    for (const p of scope.params as N[]) for (const id of patternNames(p)) out.set(id.name, id);
    if (scope.type === 'FunctionExpression' && scope.id) out.set(scope.id.name, scope);
  }
  if (scope.type === 'ForStatement' && scope.init?.type === 'VariableDeclaration') addVariables(scope.init);
  if ((scope.type === 'ForOfStatement' || scope.type === 'ForInStatement') && scope.left.type === 'VariableDeclaration') addVariables(scope.left);
  if (scope.type === 'CatchClause' && scope.param) for (const id of patternNames(scope.param)) out.set(id.name, id);
  scopes.set(scope, out);
  return out;
}

// The declaration an identifier refers to, by lexical scope; undefined for a global.
function declarationOf(id: N): Declaration | undefined {
  for (let node = parentOf(id); node; node = parentOf(node)) {
    const found = scopeDeclarations(node).get(id.name);
    if (found) return found;
  }
  return undefined;
}

// Keys that hold types, never values.
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments', 'implements', 'decorators']);
const VALUE_TS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression']);

// Calls fn on every identifier of the subtree that refers to a value (not a property name, a declared name, a label
// or a type).
function eachReference(node: N, fn: (id: N) => void): void {
  if (node.type.startsWith('TS') && !VALUE_TS.has(node.type)) return;
  switch (node.type) {
    case 'Identifier':
      fn(node);
      return;
    case 'MemberExpression':
      eachReference(node.object, fn);
      if (node.computed) eachReference(node.property, fn);
      return;
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
      if (node.computed) eachReference(node.key, fn);
      if (node.value) eachReference(node.value, fn);
      return;
    case 'VariableDeclarator':
      if (node.init) eachReference(node.init, fn);
      return;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      if (node.body) eachReference(node.body, fn);
      return;
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (node.superClass) eachReference(node.superClass, fn);
      eachReference(node.body, fn);
      return;
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      if (node.type === 'LabeledStatement') eachReference(node.body, fn);
      return;
    case 'ExportNamedDeclaration':
      if (node.declaration) eachReference(node.declaration, fn);
      return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (TYPE_KEYS.has(key)) continue;
    if (Array.isArray(value)) for (const v of value) if (isNode(v)) eachReference(v, fn);
    if (isNode(value)) eachReference(value, fn);
  }
}

// The module an import specifier names, as a repository path for a relative one.
function importTarget(spec: N): { module: string; name: string; path: string | null } {
  const decl = parentOf(spec) as N;
  const module = decl.source.value as string;
  const name = spec.type === 'ImportSpecifier' ? (spec.imported.name ?? spec.imported.value) : spec.type === 'ImportDefaultSpecifier' ? 'default' : '*';
  const path = module.startsWith('.') ? relative(ROOT, resolve(ROOT, dirname(fileOf(spec)), module)).replaceAll('\\', '/') : null;
  return { module, name, path };
}
const isImport = (decl: N) => decl.type === 'ImportSpecifier' || decl.type === 'ImportDefaultSpecifier' || decl.type === 'ImportNamespaceSpecifier';

// The top-level declaration a file exports under a name.
const exported = (file: Source, name: string): Declaration | undefined => scopeDeclarations(file.program).get(name);

// A const declarator with an initializer.
const isConst = (decl: N) => decl.type === 'VariableDeclarator' && decl.init && parentOf(decl)?.kind === 'const';

// Values the evaluator may read: package imports by name, and calls whose result is a known set (socialPublishQueue).
export interface Known {
  imports: Readonly<Record<string, unknown>>;
  calls: Readonly<Record<string, readonly string[]>>;
}

// The value of a constant expression: literals, arrays, objects, `as const`, sets, conditionals (both sides, as a
// list), constants of the same file or one it imports, and the known package imports. Throws on anything else.
function evaluate(expr: N, sources: Sources, known: Known): unknown {
  const ev = (e: N): unknown => evaluate(e, sources, known);
  const fail = () => new Error(`cannot evaluate ${textOf(expr)} (${at(expr)})`);
  switch (expr.type) {
    case 'Literal':
      return expr.value;
    case 'TemplateLiteral':
      if (expr.expressions.length > 0) throw fail();
      return expr.quasis[0].value.cooked;
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return ev(expr.expression);
    case 'ArrayExpression':
      return (expr.elements as N[]).flatMap((e) => (e.type === 'SpreadElement' ? (ev(e.argument) as unknown[]) : [ev(e)]));
    case 'ConditionalExpression':
      return [...[ev(expr.consequent)].flat(), ...[ev(expr.alternate)].flat()];
    case 'NewExpression':
      if (expr.callee.type === 'Identifier' && expr.callee.name === 'Set' && expr.arguments[0]) return ev(expr.arguments[0]);
      throw fail();
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const p of expr.properties as N[]) {
        if (p.type !== 'Property') throw fail();
        const key = p.computed ? String(ev(p.key)) : p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
        out[key] = ev(p.value);
      }
      return out;
    }
    case 'MemberExpression': {
      if (expr.computed) throw fail();
      const target = ev(expr.object) as Record<string, unknown>;
      if (target === null || typeof target !== 'object' || !Object.hasOwn(target, expr.property.name)) throw fail();
      return target[expr.property.name];
    }
    case 'CallExpression':
      if (expr.callee.type === 'Identifier' && Object.hasOwn(known.calls, expr.callee.name)) return known.calls[expr.callee.name];
      throw fail();
    case 'Identifier': {
      const decl = declarationOf(expr);
      if (decl && isConst(decl) && decl.id.type === 'Identifier') return ev(decl.init);
      if (decl && isImport(decl)) {
        const target = importTarget(decl);
        if (target.path) {
          const there = exported(sources.get(target.path), target.name);
          if (there && isConst(there)) return ev(there.init);
        } else if (Object.hasOwn(known.imports, target.name)) return known.imports[target.name];
      }
      throw fail();
    }
  }
  throw fail();
}

// The queues a queue expression names.
function queuesOf(expr: N, sources: Sources, known: Known): string[] {
  const list = [evaluate(expr, sources, known)].flat();
  if (list.length === 0 || list.some((q) => typeof q !== 'string')) throw new Error(`not a queue name: ${textOf(expr)} (${at(expr)})`);
  return list as string[];
}

// The startWorker parameter whose fields DEPS_REACH classifies.
const isDepsParam = (decl: Declaration | undefined): boolean =>
  decl !== undefined &&
  decl.type === 'Identifier' &&
  decl.typeAnnotation?.typeAnnotation?.type === 'TSTypeReference' &&
  decl.typeAnnotation.typeAnnotation.typeName?.name === 'WorkerDeps';

// The WorkerDeps path an expression stands for (deps.channels.publishers -> ['channels', 'publishers']), or null.
function depsPath(expr: N): string[] | null {
  if (expr.type === 'ChainExpression' || expr.type === 'TSNonNullExpression' || expr.type === 'ParenthesizedExpression') return depsPath(expr.expression);
  if (expr.type === 'MemberExpression' && !expr.computed) {
    const base = depsPath(expr.object);
    return base ? [...base, expr.property.name] : null;
  }
  if (expr.type === 'Identifier') {
    const decl = declarationOf(expr);
    if (isDepsParam(decl)) return [];
    if (decl?.type === 'VariableDeclarator' && decl.id.type === 'Identifier' && decl.init) return depsPath(decl.init);
  }
  return null;
}

function depsReach(path: readonly string[], node: N): readonly Reach[] {
  if (path.length === 0) throw new Error(`the whole of WorkerDeps is passed on at ${at(node)}: pass the fields it needs`);
  for (let n = path.length; n > 0; n--) {
    const key = path.slice(0, n).join('.');
    if (Object.hasOwn(DEPS_REACH, key)) return DEPS_REACH[key] as readonly Reach[];
  }
  throw new Error(`WorkerDeps field ${path[0]} is not classified in DEPS_REACH (apps/kernel/test/job-egress.ts)`);
}

// A use that only tests the value (`if (deps.push)`, `!channels`, `social && deps.channels ? ...`) or names it for
// later (`const mail = deps.mail`, followed where the name is used): it reaches nothing by itself.
function tested(node: N, inside = false): boolean {
  const p = parentOf(node);
  if (!p) return false;
  if ((p.type === 'IfStatement' || p.type === 'ConditionalExpression' || p.type === 'WhileStatement') && p.test === node) return true;
  if (p.type === 'UnaryExpression' && p.operator === '!') return true;
  if (p.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(p.operator)) return true;
  // Only a plain alias: `const c = a && deps.channels` hands the value on.
  if (p.type === 'VariableDeclarator' && p.init === node) return !inside;
  if (p.type === 'LogicalExpression' || p.type === 'ParenthesizedExpression' || p.type === 'TSNonNullExpression') return tested(p, inside || p.type === 'LogicalExpression');
  return false;
}

// What a node's code reaches, following what it refers to.
export function reachOf(root: N, sources: Sources): Set<Reach> {
  const out = new Set<Reach>();
  const seen = new Set<N>();
  // A use of WorkerDeps: at `base` for a field destructured from it, else wherever the expression points.
  const useDeps = (id: N, base?: readonly string[]) => {
    // The longest property chain from the use: deps.channels.broker is one use of channels.broker.
    let top = id;
    const chain: string[] = [];
    for (;;) {
      const p = parentOf(top);
      if (p && p.type === 'MemberExpression' && p.object === top && !p.computed) {
        chain.push(p.property.name);
        top = p;
      } else if (p && (p.type === 'ChainExpression' || p.type === 'TSNonNullExpression')) top = p;
      else break;
    }
    if (tested(top)) return;
    for (const r of depsReach(base ? [...base, ...chain] : (depsPath(top) as string[]), id)) out.add(r);
  };
  // The field of WorkerDeps a name destructured from it stands for: `const { sender } = deps.push`.
  const destructured = (decl: N, id: N): string[] | null => {
    if (decl.type !== 'VariableDeclarator' || decl.id.type !== 'ObjectPattern' || !decl.init) return null;
    const base = depsPath(decl.init);
    if (base === null) return null;
    for (const p of decl.id.properties as N[]) {
      const value = p.type === 'Property' ? (p.value.type === 'AssignmentPattern' ? p.value.left : p.value) : null;
      if (value?.type === 'Identifier' && value.name === id.name && !p.computed) return [...base, p.key.name];
    }
    throw new Error(`${at(id)}: destructure WorkerDeps one field at a time, by name`);
  };
  const follow = (node: N) => {
    if (seen.has(node)) return;
    seen.add(node);
    eachReference(node, (id) => {
      const decl = declarationOf(id);
      if (!decl) {
        const p = parentOf(id);
        // fetch itself, or through a global object (globalThis.fetch, window.fetch).
        if (id.name === 'fetch' || (GLOBAL_OBJECTS.has(id.name) && p?.type === 'MemberExpression' && p.object === id && (p.computed ? p.property.value : p.property.name) === 'fetch')) {
          out.add('raw_network');
        }
        return;
      }
      if (isDepsParam(decl) || (decl.type === 'VariableDeclarator' && decl.id.type === 'Identifier' && decl.init && depsPath(decl.init) !== null)) {
        useDeps(id);
        return;
      }
      const field = destructured(decl, id);
      if (field) {
        useDeps(id, field);
        return;
      }
      if (isImport(decl)) {
        const target = importTarget(decl);
        const whole = decl.type === 'ImportNamespaceSpecifier';
        if (NETWORK_MODULES.test(target.module)) out.add('raw_network');
        else if (target.module === '@crove/kernel-runtime' && (whole || GUARDS.has(target.name))) out.add('tenant_url');
        else if (target.module === '@crove/channel') {
          const reach = whole ? 'provider:channel' : channelReach(target.name);
          if (reach) out.add(reach);
        } else if (target.module === '@crove/agent' && (whole || AI_EXPORT.test(target.name))) out.add('provider:ai');
        else if (target.path?.startsWith(`${KERNEL_SRC}/`)) {
          const there = exported(sources.get(target.path), target.name);
          if (!there) throw new Error(`${target.path} exports no ${target.name} (imported at ${at(id)})`);
          follow(there);
        }
        return;
      }
      // A parameter (other than deps) is the caller's to pass; its value was followed where it was made.
      if (decl.type === 'Identifier') return;
      follow(decl);
    });
  };
  follow(root);
  return out;
}

const bossCall = (node: N, method: string): boolean =>
  node.type === 'CallExpression' &&
  node.callee.type === 'MemberExpression' &&
  !node.callee.computed &&
  node.callee.property.name === method &&
  node.callee.object.type === 'Identifier' &&
  node.callee.object.name === 'boss';

// Every boss.work() in the worker, with its queues and what its handler reaches.
export function workSites(sources: Sources, known: Known, file = `${KERNEL_SRC}/worker.ts`): WorkSite[] {
  const out: WorkSite[] = [];
  each(sources.get(file).program, (node) => {
    if (!bossCall(node, 'work')) return;
    const queue = node.arguments[0];
    const handler = node.arguments.at(-1);
    if (!queue || !handler || !isFunction(handler)) throw new Error(`boss.work without a queue and a handler at ${at(node)}`);
    out.push({ file, line: lineOf(node), queues: queuesOf(queue, sources, known), reaches: reachOf(handler, sources) });
  });
  return out;
}

const readable = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

// The outbox events a relay condition admits: row.type === X, X.has(row.type), X.includes(row.type),
// Object.hasOwn(X, row.type), joined by || (any) and && (the side that names events).
function eventsOf(cond: N, sources: Sources, known: Known): string[] | null {
  const isType = (e: N | undefined) => e?.type === 'MemberExpression' && !e.computed && e.property.name === 'type' && e.object.type === 'Identifier' && e.object.name === 'row';
  const list = (e: N): string[] => {
    const v = evaluate(e, sources, known);
    return (Array.isArray(v) ? v : typeof v === 'object' && v !== null ? Object.keys(v) : [v]).map(String);
  };
  if (cond.type === 'ParenthesizedExpression') return eventsOf(cond.expression, sources, known);
  if (cond.type === 'BinaryExpression' && cond.operator === '===') {
    if (isType(cond.left)) return list(cond.right);
    if (isType(cond.right)) return list(cond.left);
    return null;
  }
  if (cond.type === 'LogicalExpression' && (cond.operator === '||' || cond.operator === '&&')) {
    const left = eventsOf(cond.left, sources, known);
    const right = eventsOf(cond.right, sources, known);
    if (cond.operator === '||') return left === null || right === null ? null : [...left, ...right];
    if (left && right) return left.filter((e) => right.includes(e));
    return left ?? right;
  }
  if (cond.type === 'CallExpression' && cond.callee.type === 'MemberExpression' && !cond.callee.computed) {
    const [arg0, arg1] = cond.arguments as N[];
    const method = cond.callee.property.name;
    if ((method === 'has' || method === 'includes') && isType(arg0)) return list(cond.callee.object);
    if (method === 'hasOwn' && arg0 && isType(arg1)) return list(arg0);
  }
  return null;
}

type Route = { events: readonly string[] | null; within: string };

// How a node is reached: from the relay (with the events of the conditions around it), from a boss.work() handler, or
// from a named function. A function of the same file the relay calls is followed into the relay; its other callers
// are named by where they are.
function routesOf(node: N, sources: Sources, known: Known, seen: Set<N> = new Set()): Route[] {
  let events: string[] | null = null;
  let child = node;
  for (let p = parentOf(node); p; child = p, p = parentOf(p)) {
    if (p.type === 'IfStatement' && p.consequent === child) events = events ?? readable(() => eventsOf(p.test, sources, known));
    if (p.type === 'ConditionalExpression' && p.consequent === child) events = events ?? readable(() => eventsOf(p.test, sources, known));
    const call = parentOf(p);
    // The relay: the callback over the rows crove_kernel.outbox_claim returned.
    if (p.type === 'ArrowFunctionExpression' && call?.type === 'CallExpression' && textOf(call.callee) === 'rows.map') {
      let block: N | undefined = call;
      while (block && block.type !== 'BlockStatement') block = parentOf(block);
      if (block !== undefined && textOf(block).includes('crove_kernel.outbox_claim(')) return [{ events, within: 'the outbox relay' }];
    }
    if (bossCall(p, 'work') && p.arguments.at(-1) === child) return [{ events: null, within: `${queuesOf(p.arguments[0], sources, known).join(', ')} handler` }];
    const holder = p.type === 'FunctionDeclaration' && p.id ? p : isFunction(p) && parentOf(p)?.type === 'VariableDeclarator' && parentOf(p)?.id.type === 'Identifier' ? parentOf(p) : null;
    if (!holder) continue;
    const name: string = holder.id.name;
    if (seen.has(holder)) return [];
    seen.add(holder);
    const refs: N[] = [];
    eachReference(sources.get(fileOf(holder)).program, (id) => {
      if (id.name === name && declarationOf(id) === holder) refs.push(id);
    });
    // A caller that is neither the relay nor a handler (a sweep on a timer) is named by this function.
    const routes = refs
      .flatMap((ref) => routesOf(ref, sources, known, seen))
      .map((r) => (r.within === 'the outbox relay' || r.within.endsWith(' handler') ? { events: events ?? r.events, within: r.within } : { events: null, within: name }));
    return routes.length > 0 ? routes : [{ events: null, within: name }];
  }
  return [{ events: null, within: '(top level)' }];
}

// Every boss.send() and boss.schedule() of the kernel's own files, once per way it is reached.
export function sendSites(sources: Sources, known: Known, files = sources.list([KERNEL_SRC])): SendSite[] {
  const out: SendSite[] = [];
  for (const file of files) {
    each(sources.get(file).program, (node) => {
      if (!bossCall(node, 'send') && !bossCall(node, 'schedule')) return;
      const queue = node.arguments[0];
      if (!queue) throw new Error(`boss call without a queue at ${at(node)}`);
      const queues = queuesOf(queue, sources, known);
      for (const route of routesOf(node, sources, known)) {
        out.push({ file, line: lineOf(node), queues, events: route.within === 'the outbox relay' ? route.events : null, within: route.within });
      }
    });
  }
  return out;
}

const strip = (e: N): N => (VALUE_TS.has(e.type) || e.type === 'ParenthesizedExpression' ? strip(e.expression) : e);

// The strings an expression may be: a constant (evaluate()), any value of a constant table indexed by something else
// (PROPOSAL_PREPARERS[input.command]), a const alias of one, or a parameter, through every call of its function in its
// file (a factory's `name`, a helper's command name). Throws on anything else.
function valuesOf(expr: N, sources: Sources, known: Known, seen: Set<N> = new Set()): string[] {
  const strings = (v: unknown): string[] => {
    const list = [v].flat();
    if (list.length === 0 || list.some((s) => typeof s !== 'string')) throw new Error(`not a command name: ${textOf(expr)} (${at(expr)})`);
    return list as string[];
  };
  const direct = readable(() => evaluate(expr, sources, known));
  if (direct !== null) return strings(direct);
  const fail = () => new Error(`cannot read ${textOf(expr)} (${at(expr)})`);
  const e = strip(expr);
  if (e.type === 'MemberExpression' && e.computed) {
    const table = readable(() => evaluate(e.object, sources, known));
    if (table === null || typeof table !== 'object') throw fail();
    return strings(Object.values(table as Record<string, unknown>).flat());
  }
  if (e.type !== 'Identifier') throw fail();
  const decl = declarationOf(e);
  if (decl && isConst(decl) && decl.id.type === 'Identifier') return valuesOf(decl.init, sources, known, seen);
  // A parameter already on the way here is a recursion the test does not follow.
  if (decl?.type !== 'Identifier' || seen.has(decl)) throw fail();
  const path = new Set(seen).add(decl);
  // A parameter: the argument at its place in every call of the named function that declares it.
  let fn = parentOf(decl);
  while (fn && !isFunction(fn)) fn = parentOf(fn);
  const index = fn ? (fn.params as N[]).findIndex((p) => p === decl || (p.type === 'AssignmentPattern' && p.left === decl)) : -1;
  if (!fn || index < 0) throw fail();
  const holder = fn.type === 'FunctionDeclaration' && fn.id ? fn : parentOf(fn)?.type === 'VariableDeclarator' && parentOf(fn)?.id.type === 'Identifier' ? parentOf(fn) : null;
  if (!holder) throw fail();
  // Called only in its own file: an exported function may be called from anywhere.
  if (parentOf(holder)?.type === 'ExportNamedDeclaration' || parentOf(parentOf(holder) as N)?.type === 'ExportNamedDeclaration') throw fail();
  const out: string[] = [];
  let calls = 0;
  eachReference(sources.get(fileOf(holder)).program, (id) => {
    if (id.name !== holder.id.name || declarationOf(id) !== holder) return;
    const call = parentOf(id);
    // Handed on as a value, its calls are out of sight.
    if (call?.type !== 'CallExpression' || call.callee !== id) throw fail();
    const arg = (call.arguments as N[])[index];
    const param = (fn as N).params[index] as N;
    const given = arg ?? (param.type === 'AssignmentPattern' ? param.right : undefined);
    if (!given || given.type === 'SpreadElement') throw fail();
    out.push(...valuesOf(given, sources, known, path));
    calls++;
  });
  if (calls === 0) throw fail();
  return out;
}

// The command definition (an object with a name, a risk and a handler) a node is in, with the names it may have, or
// the named function it is in.
function enclosing(node: N, sources: Sources, known: Known): { commands: string[] } | { fn: Declaration; name: string } | null {
  for (let n = parentOf(node); n; n = parentOf(n)) {
    if (n.type === 'ObjectExpression') {
      const props = new Map((n.properties as N[]).filter((p) => p.type === 'Property' && !p.computed && p.key.type === 'Identifier').map((p) => [p.key.name as string, p.value as N]));
      const name = props.get('name');
      if (name && props.has('handler') && props.has('risk')) return { commands: valuesOf(name, sources, known) };
    }
    if (n.type === 'FunctionDeclaration' && n.id) return { fn: n, name: n.id.name };
    const p = parentOf(n);
    if ((n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') && p?.type === 'VariableDeclarator' && p.id.type === 'Identifier') return { fn: p, name: p.id.name };
    if (n.type === 'MethodDefinition') return null;
  }
  return null;
}

interface Emitters {
  // Event type -> the commands that may emit it, themselves or through the nested commands they run.
  commands: Map<string, Set<string>>;
  // Command -> the nested commands it may run (ctx.run, ctx.tryRun).
  runs: Map<string, Set<string>>;
  // Emit and nested run sites the test cannot tie to a command or read the type or the command of.
  problems: string[];
}

// The commands a nested run whose command is not in its source may run, by '<file>: <its command expression>': the
// caller works them out from the registered definitions (the R0 preparers, the revisers, the proposal commands).
export type DynamicRuns = Readonly<Record<string, readonly string[]>>;

const isNestedRun = (node: N): boolean =>
  node.type === 'CallExpression' &&
  node.callee.type === 'MemberExpression' &&
  !node.callee.computed &&
  (node.callee.property.name === 'run' || node.callee.property.name === 'tryRun') &&
  node.callee.object.type === 'Identifier' &&
  node.callee.object.name === 'ctx';

// The commands that emit each of the events, with the emit sites under the directories, and every command that runs
// one of those as a nested command, transitively.
export function emittersOf(events: readonly string[], sources: Sources, known: Known, dirs: readonly string[], dynamic: DynamicRuns = {}): Emitters {
  const files = sources.list(dirs);
  const wanted = new Set(events);
  const commands = new Map<string, Set<string>>(events.map((e) => [e, new Set<string>()]));
  const runs = new Map<string, Set<string>>();
  const usedDynamic = new Set<string>();
  const problems: string[] = [];
  // The strings an emit's type may be: a constant, or a variable assigned only constants (null aside).
  const typesOf = (expr: N): string[] | null => {
    const direct = readable(() => [evaluate(expr, sources, known)].flat().map(String));
    if (direct || expr.type !== 'Identifier') return direct;
    const decl = declarationOf(expr);
    if (decl?.type !== 'VariableDeclarator') return null;
    const values: string[] = [];
    let ok = true;
    const add = (e: N) => {
      if (e.type === 'Literal' && e.value === null) return;
      const v = readable(() => [evaluate(e, sources, known)].flat().map(String));
      if (v) values.push(...v);
      else ok = false;
    };
    if (decl.init) add(decl.init);
    // The block the variable is declared in (past an export), where every assignment to it is.
    let scope = parentOf(decl) as N;
    while (!['Program', 'BlockStatement', 'StaticBlock', 'SwitchCase'].includes(scope.type)) scope = parentOf(scope) as N;
    each(scope, (n) => {
      if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier' && declarationOf(n.left) === decl) add(n.right);
    });
    return ok ? values : null;
  };
  // The commands a node runs in, through the functions that use it.
  const commandsOf = (node: N, depth: number, seen: Set<Declaration>): string[] | string => {
    const found = enclosing(node, sources, known);
    if (!found) return `${at(node)} is in no command and no named function`;
    if ('commands' in found) return found.commands;
    if (seen.has(found.fn)) return [];
    seen.add(found.fn);
    if (depth > 8) return `${at(node)}: too many calls deep`;
    const defined = fileOf(found.fn);
    const uses: N[] = [];
    for (const file of files) {
      const source = sources.get(file);
      if (file !== defined && !source.text.includes(found.name)) continue;
      eachReference(source.program, (id) => {
        if (id.name !== found.name) return;
        const decl = declarationOf(id);
        if (decl === found.fn) uses.push(id);
        else if (decl && decl.type === 'ImportSpecifier') {
          const target = importTarget(decl);
          if (target.name === found.name && (target.path === null || target.path === defined)) uses.push(id);
        }
      });
    }
    if (uses.length === 0) return `${found.name} (${at(found.fn)}) emits, and nothing in ${dirs.join(', ')} uses it`;
    const out: string[] = [];
    for (const use of uses) {
      const names = commandsOf(use, depth + 1, seen);
      if (typeof names === 'string') return names;
      out.push(...names);
    }
    return out;
  };
  // A nested run: the commands that run it, and the commands it may run.
  const nested = (node: N) => {
    const arg = node.arguments[0] as N | undefined;
    if (!arg) {
      problems.push(`${at(node)}: a nested run without a command`);
      return;
    }
    const key = `${fileOf(node)}: ${textOf(arg)}`;
    let callees = readable(() => valuesOf(arg, sources, known));
    if (callees === null && Object.hasOwn(dynamic, key)) {
      usedDynamic.add(key);
      callees = [...(dynamic[key] as readonly string[])];
    }
    if (callees === null) {
      problems.push(`${at(node)}: a nested run whose command the test cannot read (${textOf(arg)}); name the commands it may run in the test's dynamic runs`);
      return;
    }
    const callers = commandsOf(node, 0, new Set());
    if (typeof callers === 'string') {
      problems.push(`nested run of ${callees.join(', ')}: ${callers}`);
      return;
    }
    for (const caller of callers) {
      const to = runs.get(caller) ?? new Set<string>();
      for (const callee of callees) to.add(callee);
      runs.set(caller, to);
    }
  };
  for (const file of files) {
    each(sources.get(file).program, (node) => {
      if (isNestedRun(node)) {
        nested(node);
        return;
      }
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.name !== 'emit' || node.arguments.length < 2) return;
      const type = node.arguments[0] as N;
      const types = typesOf(type);
      if (types === null) {
        problems.push(`${at(node)}: an emit whose type the test cannot read (${textOf(type)})`);
        return;
      }
      const hit = types.filter((t) => wanted.has(t));
      if (hit.length === 0) return;
      const names = commandsOf(node, 0, new Set());
      if (typeof names === 'string') {
        problems.push(`emit of ${hit.join(', ')}: ${names}`);
        return;
      }
      for (const t of hit) for (const c of names) commands.get(t)?.add(c);
    });
  }
  for (const key of Object.keys(dynamic)) if (!usedDynamic.has(key)) problems.push(`the dynamic run ${key} is no longer in the sources`);
  // A command that runs an emitter, or a command that runs one, emits what it emits.
  for (const by of commands.values()) {
    for (let grown = true; grown; ) {
      grown = false;
      for (const [caller, callees] of runs) {
        if (by.has(caller)) continue;
        if ([...callees].some((c) => by.has(c))) {
          by.add(caller);
          grown = true;
        }
      }
    }
  }
  return { commands, runs, problems };
}
