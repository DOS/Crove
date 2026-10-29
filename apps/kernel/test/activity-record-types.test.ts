// Every record type an activity row is written for (ctx.activity in modules, packages and apps) is either scoped by
// legal entity, listed in the trigger b_legal_entity on crove_kernel.activity (the newest migration that creates it,
// #1716), named with its entity at every call (options.legalEntityId, #1725), or org-level for a reason given here. A
// new record type of an entity's record that is in none of these would show that entity's activity to members limited
// to other entities, so it fails here until it is listed. Calls are found whatever the context object is called, an
// activity function taken out of its context (destructured, assigned, bound) fails, and a call whose record type is
// computed must name its entity (#1728).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'supabase/migrations');

// Record types whose activity rows are org-level, and why. Sorted.
const ORG_LEVEL = new Map<string, string>([
  ['finance.org_account', "the org's chart of accounts is org-wide"],
  ['kernel.agent', 'the org chart is org-wide'],
  ['kernel.file', 'a file has no entity (its readings do)'],
  ['kernel.member', 'a member of the org (an assignment limited to an entity is a role change, kept org-wide, #1725)'],
  ['kernel.member_invite', 'an invite to the org'],
  ['kernel.org', "the org's own settings"],
  ['kernel.party', 'parties are org-wide until #1538 (record_le links them)'],
  ['kernel.position', 'the org chart is org-wide'],
  ['kernel.tenant', "the org's own settings"],
  ['kernel.user', "a member's sessions"],
]);
// Record types whose record names no entity, written with the entity the action was for at every call (#1725). Sorted.
const ENTITY_NAMED = new Map<string, string>([
  ['finance.archive', "a year's package: one row per entity whose books it holds"],
  ['finance.period', "one entity's month, locked or unlocked"],
  ['kernel.mail_message', "a missing-invoice request about one entity's purchases, or a reminder row per entity"],
]);

interface Call {
  where: string;
  // The first argument when it is a string literal, else null (computed).
  type: string | null;
  expression: string;
  namesEntity: boolean;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'test' && name !== 'dist') sources(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function srcDirs(): string[] {
  const dirs: string[] = [];
  for (const group of ['apps', 'modules', 'packages']) {
    for (const name of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, name, 'src');
      try {
        if (statSync(src).isDirectory()) dirs.push(src);
      } catch {
        // no src directory
      }
    }
  }
  return dirs;
}

// The text of the arguments of the call whose '(' is at `open`, up to its matching ')': strings, template literals
// (with their ${} parts) and comments are skipped over, so a parenthesis inside them does not count.
function argumentsAt(text: string, open: number): string {
  let depth = 0;
  // Template literals being read, each with the brace depth its ${} parts started at.
  const templates: number[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (templates.length > 0 && depth === templates[templates.length - 1]) {
      // Inside a template literal's text.
      if (c === '\\') i++;
      else if (c === '`') templates.pop();
      else if (c === '$' && text[i + 1] === '{') {
        depth++;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '`') {
      templates.push(depth);
    } else if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1;
      if (i <= 0) break;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced call at ${open}`);
}

function calls(file: string, text: string): Call[] {
  const out: Call[] = [];
  for (const m of text.matchAll(/\.activity\s*\(/g)) {
    const args = argumentsAt(text, (m.index ?? 0) + m[0].length - 1);
    const first = /^\s*(?:'([^']+)'|([^,]+?))\s*,/.exec(args);
    // The entity is named by the last argument: an object literal with a legalEntityId that is not undefined.
    const namesEntity = /\{[^{}]*\blegalEntityId\b(?!\s*:\s*undefined\b)[^{}]*\}\s*,?\s*$/.test(args);
    out.push({ where: file, type: first?.[1] ?? null, expression: (first?.[1] ?? first?.[2] ?? args).trim(), namesEntity });
  }
  return out;
}

// An activity function taken out of its context: destructured from it, assigned or bound. Calls through such a name
// would not be found above. Comments are left out first, so prose naming ctx.activity is not taken for code.
function aliases(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [
    ...text.matchAll(/\{[^{}]*\bactivity\b[^{}]*\}\s*=\s*[A-Za-z_$][\w$.]*/g),
    ...text.matchAll(/[=:,(]\s*[A-Za-z_$][\w$]*\.activity\b(?!\s*\()(?!\s*:)/g),
    ...text.matchAll(/\.activity\.(?:bind|call|apply)\b/g),
    // A parameter destructured as ({ activity }: CommandContext), and a call by computed name (ctx['activity']).
    ...text.matchAll(/\(\s*\{[^{}]*\bactivity\b[^{}]*\}\s*:/g),
    ...text.matchAll(/\[\s*['"`]activity['"`]\s*\]/g),
  ].map((m) => m[0].replace(/\s+/g, ' ').trim());
}

// The record types the newest migration that creates the trigger lists: ARRAY['<type>', '<table>', ...] rows.
function scopedTypes(): Set<string> {
  const files = readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .filter((n) => readFileSync(join(MIGRATIONS, n), 'utf8').includes('crove_kernel.activity_legal_entity_fill('));
  const newest = files.at(-1);
  if (!newest) throw new Error('no migration creates the trigger b_legal_entity on crove_kernel.activity');
  const text = readFileSync(join(MIGRATIONS, newest), 'utf8');
  return new Set([...text.matchAll(/ARRAY\['([a-z_.]+)', 'crove_[a-z_]+\.[a-z_]+'/g)].map((m) => m[1] as string));
}

describe('activity record types (#1716, #1725, #1728)', () => {
  const scoped = scopedTypes();
  const all: Call[] = [];
  const aliased: string[] = [];
  for (const dir of srcDirs()) {
    for (const file of sources(dir)) {
      const text = readFileSync(file, 'utf8');
      const where = relative(ROOT, file).replaceAll('\\', '/');
      all.push(...calls(where, text));
      aliased.push(...aliases(text).map((a) => `${where}: ${a}`));
    }
  }
  const literal = new Map<string, string[]>();
  for (const c of all) if (c.type) literal.set(c.type, [...(literal.get(c.type) ?? []), c.where]);

  it('finds the activity calls and the trigger list', () => {
    expect(scoped).toContain('finance.journal_entry');
    expect(literal.get('kernel.proposal')?.length).toBeGreaterThan(0);
    expect(literal.get('finance.period')?.length).toBeGreaterThan(0);
  });

  it('finds calls through any context object, and none through an activity function taken out of it', () => {
    // The scan itself: a call on another name, one split over lines with nested calls and template literals, and a
    // destructured or assigned activity function.
    const sample = [
      "await c.activity('finance.period', id, 'k', `a ${f(x, (y))} b`, { legalEntityId: e });",
      'await context\n  .activity(t.kind, id, "k", s);',
      'const { activity, emit } = ctx;',
      'const write = ctx.activity;',
      'const run = async ({ activity }: CommandContext) => 1;',
      "await ctx['activity']('kernel.tenant', id, 'k', s);",
      "await ctx.activity('finance.period', id, 'k', `${legalEntityId}`);",
      "await ctx.activity('finance.period', id, 'k', s, { legalEntityId: undefined });",
    ].join('\n');
    expect(calls('sample.ts', sample).map((c) => [c.type, c.expression, c.namesEntity])).toEqual([
      ['finance.period', 'finance.period', true],
      [null, 't.kind', false],
      // A legalEntityId in the summary, or one that is undefined, names no entity.
      ['finance.period', 'finance.period', false],
      ['finance.period', 'finance.period', false],
    ]);
    expect(aliases(sample)).toHaveLength(4);
    expect(aliased, 'call ctx.activity(...) on the context itself, so this guard sees the call').toEqual([]);
  });

  it('lists every literal record type as scoped by legal entity, named with its entity, or org-level, once', () => {
    const unlisted = [...literal.keys()]
      .filter((t) => !scoped.has(t) && !ORG_LEVEL.has(t) && !ENTITY_NAMED.has(t))
      .map((t) => `${t} (${literal.get(t)?.join(', ')})`);
    expect(unlisted, 'add each to the trigger list of crove_kernel.activity (a migration), to ENTITY_NAMED, or to ORG_LEVEL with a reason').toEqual([]);
    const lists = [[...scoped], [...ORG_LEVEL.keys()], [...ENTITY_NAMED.keys()]];
    const twice = [...new Set(lists.flat())].filter((t) => lists.filter((l) => l.includes(t)).length > 1);
    expect(twice, 'record types in more than one list').toEqual([]);
    for (const [name, list] of [['ORG_LEVEL', ORG_LEVEL], ['ENTITY_NAMED', ENTITY_NAMED]] as const) {
      expect([...list.keys()].filter((t) => !literal.has(t)), `${name} lists a record type no activity call uses`).toEqual([]);
      expect([...list.keys()], `${name} is kept sorted`).toEqual([...list.keys()].sort());
    }
  });

  it('lists the entity-named record types in the database constraint that makes them name an entity', () => {
    const files = readdirSync(MIGRATIONS)
      .filter((n) => n.endsWith('.sql'))
      .sort()
      .filter((n) => readFileSync(join(MIGRATIONS, n), 'utf8').includes('ADD CONSTRAINT activity_entity_named'));
    const newest = files.at(-1);
    if (!newest) throw new Error('no migration adds the constraint activity_entity_named on crove_kernel.activity');
    const list = /record_type NOT IN \(([^)]*)\) OR legal_entity_id IS NOT NULL/.exec(readFileSync(join(MIGRATIONS, newest), 'utf8'))?.[1] ?? '';
    expect([...list.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort(), 'the constraint and ENTITY_NAMED name the same record types').toEqual([...ENTITY_NAMED.keys()]);
  });

  it('names the entity at every call of an entity-named record type, and at every computed one', () => {
    const missing = all
      .filter((c) => (c.type === null || ENTITY_NAMED.has(c.type)) && !c.namesEntity)
      .map((c) => `${c.where}: ${c.expression}`);
    expect(missing, 'pass { legalEntityId } to ctx.activity').toEqual([]);
  });
});
