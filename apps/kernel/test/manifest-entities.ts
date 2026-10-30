// Module manifests' entities against their tables, numbering series and commands (plan §5.2 `entities`, §10 G3, #1656).
// entityProblems() is pure: manifest-entities.test.ts feeds it the commands' audit targets and planted mismatches;
// manifest.db.test.ts adds the catalog: the columns of every table, the tables carrying the append-only trigger, and the
// numbering calls of every trigger function. Each problem is one line naming what to change.
import type { ModuleManifest } from '@crove/kernel-contract';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { numberReseedCommand } from '../src/restore-report.ts';
import type { Manifests } from './manifest-permissions.ts';

// A doc type as crove_kernel.number_series' CHECK accepts it, optionally ending in `<column>` (EntityDeclaration).
const DOC_TYPE = /^[a-z][a-z0-9_.]*(<[a-z_][a-z0-9_]*>)?$/;
const NAME = /^[a-z][a-z0-9_]*$/;

// Audit target types that are no module's entity, with the reason.
export const NOT_ENTITIES: Readonly<Record<string, string>> = {
  'kernel.user': 'an account: a control-plane row (plan §3.6), which no module source may name',
};

// A series a trigger function numbers its table's rows in: crove_kernel.number_allocate(..., docType, ..., targetType, ...).
export interface NumberingCall {
  table: string;
  by: string;
  docType: string;
  targetType: string;
}

export interface CatalogFacts {
  // schema.table -> its columns.
  columns: ReadonlyMap<string, ReadonlySet<string>>;
  // schema.table of every table with the append_only_row trigger.
  appendOnly: ReadonlySet<string>;
  numbering: readonly NumberingCall[];
}

export interface TargetUse {
  type: string;
  by: string;
}

// A function body with its SQL comments (`--` to the end of the line, `/* */`) removed and string literals kept, so a
// quote, comma or parenthesis in a comment, or a commented-out call, is not read as code. Block comments are not
// nested in Crove's functions. manifest-permissions.ts reads permissions from the same text.
export function stripSqlComments(body: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch === "'") quoted = !quoted;
    if (!quoted && body.startsWith('--', i)) {
      const end = body.indexOf('\n', i);
      i = (end === -1 ? body.length : end) - 1;
    } else if (!quoted && body.startsWith('/*', i)) {
      const end = body.indexOf('*/', i + 2);
      i = (end === -1 ? body.length : end + 2) - 1;
    } else out += ch;
  }
  return out;
}

// The arguments of every call of crove_kernel.number_allocate in a function body, split at top-level commas.
function allocateCalls(source: string): string[][] {
  const body = stripSqlComments(source);
  const calls: string[][] = [];
  const marker = 'crove_kernel.number_allocate(';
  for (let at = body.indexOf(marker); at !== -1; at = body.indexOf(marker, at + 1)) {
    const args: string[] = [];
    let depth = 0;
    let quoted = false;
    let current = '';
    for (const ch of body.slice(at + marker.length)) {
      if (ch === "'") quoted = !quoted;
      if (!quoted && ch === '(') depth += 1;
      if (!quoted && ch === ')' && depth-- === 0) break;
      if (!quoted && ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
      } else current += ch;
    }
    args.push(current.trim());
    calls.push(args);
  }
  return calls;
}

// The series a trigger function on `table` numbers: the doc type (a literal, or a literal prefix || NEW.<column>, written
// `<prefix><column>`) and the target type (a literal). A call written any other way is a problem, so a new shape cannot
// slip past the check.
export function numberingCalls(table: string, by: string, body: string): { calls: NumberingCall[]; problems: string[] } {
  const calls: NumberingCall[] = [];
  const problems: string[] = [];
  for (const args of allocateCalls(body)) {
    const doc = /^'([a-z0-9_.]+)'(?:\s*\|\|\s*NEW\.([a-z_][a-z0-9_]*))?$/.exec(args[2] ?? '');
    const target = /^'([a-z0-9_.]+)'$/.exec(args[4] ?? '');
    if (!doc || !target || args.length !== 6) {
      problems.push(`${by} on ${table}: cannot read its call of crove_kernel.number_allocate(${args.join(', ')}); write the doc type as a literal or a literal || NEW.<column>, and the target type as a literal`);
      continue;
    }
    calls.push({ table, by, docType: doc[2] ? `${doc[1]}<${doc[2]}>` : (doc[1] as string), targetType: target[1] as string });
  }
  return { calls, problems };
}

// Something that answers any property, call or conversion with itself (a string when converted), as a command's input
// to its `target`. A target's type must be a literal and its object unconditional: the proxy is always truthy, so of
// `input.a ? { type: 'x' } : { type: 'y' }` only x would be read.
function anyInput(): unknown {
  const proxy: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => 'x' : key === 'then' ? undefined : proxy),
    apply: () => proxy,
  });
  return proxy;
}

// The audit target types of every command the deployment registers with every module on (and the purge command the
// kernel registers on its own). A target whose type is not a string is a problem.
export function commandTargetTypes(): { uses: TargetUse[]; problems: string[] } {
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' });
  const commands = [...moduleDefinitions(config).commands, orgPurgeCommand({ store: {} as never }), numberReseedCommand()];
  const uses: TargetUse[] = [];
  const problems: string[] = [];
  for (const c of commands) {
    if (!c.target) continue;
    let type: unknown;
    try {
      type = (c.target as (input: unknown) => { type: unknown } | null)(anyInput())?.type;
    } catch (err) {
      problems.push(`command ${c.name}: its target threw on a probe input (${String(err)})`);
      continue;
    }
    if (typeof type === 'string') uses.push({ type, by: `command ${c.name}` });
    else problems.push(`command ${c.name}: its target's type is not a string literal`);
  }
  return { uses, problems };
}

const schemaOf = (manifest: ModuleManifest) => `crove_${manifest.id}`;

// What does not hold:
// - an entity whose type is not `<module id>.<entity>`, or that another entity also declares, or whose table another
//   entity also names;
// - an entity whose table the module's own schema does not hold, in the manifest or in the catalog;
// - legalEntityScoped that differs from the table having legal_entity_id;
// - audit append_only that differs from the table carrying the append-only trigger;
// - a numbered entity that is not legal-entity scoped, whose doc type is malformed or names a column the table does not
//   have, or that no trigger numbers with its doc type and its type as the target;
// - a trigger that numbers rows for a series no entity declares;
// - a command whose audit target type no manifest declares as an entity (NOT_ENTITIES aside).
export function entityProblems(manifests: Manifests, facts: CatalogFacts | null, targets: readonly TargetUse[] = []): string[] {
  const problems: string[] = [];
  const types = new Map<string, string>();
  const tables = new Map<string, string>();
  for (const { manifest, file } of Object.values(manifests)) {
    const schema = schemaOf(manifest);
    for (const e of manifest.entities) {
      const [module, name, ...rest] = e.type.split('.');
      if (module !== manifest.id || !name || !NAME.test(name) || rest.length > 0) problems.push(`${file}: entity ${e.type} is not named ${manifest.id}.<entity>`);
      if (types.has(e.type)) problems.push(`${file}: entity ${e.type} is also declared in ${types.get(e.type)}`);
      types.set(e.type, file);
      const key = `${schema}.${e.table}`;
      if (tables.has(key)) problems.push(`${file}: entity ${e.type} names ${key}, which entity ${tables.get(key)} also names`);
      tables.set(key, e.type);
      if (!manifest.tables[schema] || !Object.hasOwn(manifest.tables[schema], e.table)) problems.push(`${file}: entity ${e.type} names ${key}, which the manifest does not own`);
      if (e.numbering) {
        if (!DOC_TYPE.test(e.numbering.docType) || e.numbering.docType.length > 100) problems.push(`${file}: entity ${e.type} has the malformed doc type ${e.numbering.docType}`);
        if (!e.legalEntityScoped) problems.push(`${file}: entity ${e.type} is numbered, but not legalEntityScoped: every number series belongs to a legal entity`);
      }
      if (!facts) continue;
      const cols = facts.columns.get(key);
      if (!cols) {
        problems.push(`${file}: entity ${e.type} names ${key}, which the migrations do not create`);
        continue;
      }
      if (e.legalEntityScoped !== cols.has('legal_entity_id')) {
        problems.push(`${file}: entity ${e.type} has legalEntityScoped: ${e.legalEntityScoped}, but ${key} ${cols.has('legal_entity_id') ? 'has' : 'has no'} legal_entity_id column`);
      }
      const appendOnly = facts.appendOnly.has(key);
      if ((e.audit === 'append_only') !== appendOnly) {
        problems.push(`${file}: entity ${e.type} has audit: ${e.audit}, but ${key} ${appendOnly ? 'is' : 'is not'} append-only (crove_kernel.make_append_only)`);
      }
      if (e.numbering) {
        const column = /<([a-z_][a-z0-9_]*)>$/.exec(e.numbering.docType)?.[1];
        if (column && !cols.has(column)) problems.push(`${file}: entity ${e.type} numbers by ${column}, which ${key} does not have`);
        const docType = e.numbering.docType;
        if (!facts.numbering.some((n) => n.table === key && n.docType === docType && n.targetType === e.type)) {
          problems.push(`${file}: entity ${e.type} is numbered as ${docType}, but no trigger on ${key} allocates that series for target ${e.type}`);
        }
      }
    }
  }
  if (facts) {
    for (const n of facts.numbering) {
      const owner = Object.values(manifests).find(({ manifest }) =>
        manifest.entities.some((e) => `${schemaOf(manifest)}.${e.table}` === n.table && e.type === n.targetType && e.numbering?.docType === n.docType),
      );
      if (!owner) problems.push(`${n.by} on ${n.table} numbers series ${n.docType} for target ${n.targetType}, which no entity declares: declare it with numbering in the manifest of ${n.table}`);
    }
  }
  for (const t of targets) {
    if (!types.has(t.type) && !Object.hasOwn(NOT_ENTITIES, t.type)) problems.push(`${t.by} names the audit target type ${t.type}, which no manifest declares as an entity`);
  }
  return problems;
}
