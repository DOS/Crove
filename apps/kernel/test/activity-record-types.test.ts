// Every record type an activity row is written for (ctx.activity in modules, packages and apps) is either scoped by
// legal entity, listed in the trigger b_legal_entity on crove_kernel.activity (the newest migration that creates it,
// #1716), or org-level for a reason given here. A new record type of an entity's record that is in neither list would
// show that entity's activity to members limited to other entities, so it fails here until it is listed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'supabase/migrations');

// Record types whose activity rows are org-level, and why. Sorted.
const ORG_LEVEL = new Map<string, string>([
  ['finance.archive', 'record id is the org id; per-entity archive rows are #1725'],
  ['finance.org_account', "the org's chart of accounts is org-wide"],
  ['finance.period', 'record id is the org id; per-entity period lock rows are #1725'],
  ['kernel.agent', 'the org chart is org-wide'],
  ['kernel.file', 'a file has no entity (its readings do)'],
  ['kernel.mail_message', 'a mail has no entity; per-entity reminder rows are #1725'],
  ['kernel.member', 'a member of the org'],
  ['kernel.member_invite', 'an invite to the org'],
  ['kernel.org', "the org's own settings"],
  ['kernel.party', 'parties are org-wide until #1538 (record_le links them)'],
  ['kernel.position', 'the org chart is org-wide'],
  ['kernel.proposal', 'a stamp, not a scope, until #1538: agents have an empty le_scope'],
  ['kernel.tenant', "the org's own settings"],
  ['kernel.user', "a member's sessions"],
]);
// Calls whose record type is computed, with the reason they are covered. Keyed by file and expression.
const DYNAMIC = new Map<string, string>([
  ['packages/kernel/src/numbering.ts: allocation.target_type', 'a voided allocation; vouchers cannot be voided by number and no other allocator exists yet'],
]);

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

describe('activity record types (#1716)', () => {
  const scoped = scopedTypes();
  const literal = new Map<string, string[]>();
  const dynamic: string[] = [];
  for (const dir of srcDirs()) {
    for (const file of sources(dir)) {
      const text = readFileSync(file, 'utf8');
      const where = relative(ROOT, file).replaceAll('\\', '/');
      for (const m of text.matchAll(/\bctx\.activity\(\s*(?:'([^']+)'|([^,]+?))\s*,/g)) {
        if (m[1]) literal.set(m[1], [...(literal.get(m[1]) ?? []), where]);
        else dynamic.push(`${where}: ${m[2]?.trim()}`);
      }
    }
  }

  it('finds the activity calls and the trigger list', () => {
    expect(scoped).toContain('finance.journal_entry');
    expect(literal.get('kernel.proposal')?.length).toBeGreaterThan(0);
  });

  it('lists every literal record type as scoped by legal entity or org-level, never both', () => {
    const unlisted = [...literal.keys()].filter((t) => !scoped.has(t) && !ORG_LEVEL.has(t)).map((t) => `${t} (${literal.get(t)?.join(', ')})`);
    expect(unlisted, 'add each to the trigger list of crove_kernel.activity (a migration) or to ORG_LEVEL with a reason').toEqual([]);
    expect([...ORG_LEVEL.keys()].filter((t) => scoped.has(t)), 'record types both scoped and org-level').toEqual([]);
    expect([...ORG_LEVEL.keys()].filter((t) => !literal.has(t)), 'ORG_LEVEL lists a record type no activity call uses').toEqual([]);
    const keys = [...ORG_LEVEL.keys()];
    expect(keys, 'ORG_LEVEL is kept sorted').toEqual([...keys].sort());
  });

  it('explains every computed record type', () => {
    expect(dynamic.filter((d) => !DYNAMIC.has(d)), 'add each computed record type to DYNAMIC with the reason it is covered').toEqual([]);
    expect([...DYNAMIC.keys()].filter((d) => !dynamic.includes(d)), 'DYNAMIC lists a call that no longer exists').toEqual([]);
  });
});
