// Audit facts keep no classified value (#1626, plan §4.10): a source scan of every audit fact a command writes, through
// ctx.audit(...) or the audit facts of a DomainError ({ audit: { ... } }). It fails when
// - a fact's key names a column some manifest classifies (anything but internal: pii, contact, payment, national_id,
//   national_id_if_individual, sensitive), in snake_case or camelCase, and its value is not auditValue(...), or
// - a fact's value reads such a column (`before.tax_code`, `party.name`) outside auditValue(...).
// auditValue (@crove/kernel-contract) replaces a classified value with a marker naming its class. The scan reads only the
// call's text: facts built elsewhere and passed in by name (`previous`, built in a loop), spreads (`...row`) and other
// names for a classified value (`{ code: taxCode }`) are not checked here, so wrap each value where it is built; the db
// tests (audit-facts.db.test.ts and each command's own) check what the rows hold. Column names that are also ordinary words of internal data (an account's name, a
// command's name) are listed below with their reason, per file; adding one says that value is not a person's.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditValue, columns, type DataClass, type ModuleManifest } from '@crove/kernel-contract';
import { kernelManifest } from '@crove/kernel';
import { crmManifest } from '@crove/mod-crm';
import { financeManifest } from '@crove/mod-finance';
import { socialManifest } from '@crove/mod-social';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNED = ['packages', 'modules', 'apps/kernel/src'];

// The control plane's classified columns (apps/kernel/test/manifest.db.test.ts declares their tables; no source may name
// those tables, but a fact could still carry one of their values).
const CONTROL_PLANE_CLASSIFIED = ['subject', 'email', 'display_name', 'token', 'recipient'];

// Facts whose key or value names a classified column but holds internal data, per file, with the reason.
// An entry is a fact key or a column read (`info.name`) and covers that name in its file.
const ALLOWED: Record<string, Record<string, string>> = {
  'packages/kernel/src/agents.ts': { 'info.name': 'the name of the command a proposal runs' },
  'packages/kernel/src/proposal-reminders.ts': { recipients: 'how many members each stage reminded, a count per stage' },
  'modules/finance/src/accounts.ts': { name: "the name of an account of the org's chart (crove_finance.account.name, internal)" },
  'modules/finance/src/bank.ts': { bankAccount: 'the chart account code (112x) the statement is for, not a bank account number' },
  'modules/finance/src/missing-invoices.ts': { skipped: 'the periods too large to reconcile' },
  'modules/finance/src/portal-list.ts': { skipped: "the count of the portal list's skipped rows, not the rows" },
  'modules/social/src/archive.ts': { skipped: 'the post ids left out and why' },
  'modules/social/src/bulk-edit.ts': { skipped: 'the post ids left out and why' },
  'modules/social/src/digest.ts': { skipped: 'the count of digest mails that failed' },
  'modules/social/src/report-branding.ts': { name: "the org's own brand name on its reports (crove_social.report_branding.display_name, internal)" },
  'modules/social/src/report-schedules.ts': { recipients: 'the count of recipients, never their addresses' },
};

function classifiedColumns(): Set<string> {
  const out = new Set<string>(CONTROL_PLANE_CLASSIFIED);
  for (const manifest of [kernelManifest, financeManifest, crmManifest, socialManifest] as ModuleManifest[]) {
    for (const tables of Object.values(manifest.tables)) {
      for (const cols of Object.values(tables)) {
        for (const [column, cls] of Object.entries(cols) as Array<[string, DataClass]>) if (cls !== 'internal') out.add(column);
      }
    }
  }
  return out;
}

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'dist' || name === 'generated') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

// Comments blanked and the contents of '...' and "..." strings blanked (line breaks kept), so neither a comment nor a
// string can open or close a bracket. Template literals are kept as they are: their ${...} are code.
function blank(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      out += text[i] ?? '';
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else if (c === "'" || c === '"') {
      out += c;
      i++;
      while (i < text.length && text[i] !== c && text[i] !== '\n') {
        out += text[i] === '\\' ? '  ' : ' ';
        if (text[i] === '\\') i++;
        i++;
      }
      out += text[i] ?? '';
    } else {
      out += c;
    }
  }
  return out;
}

// The text from `open` (an opening bracket) to its matching close, both included.
function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

// The value expression after a key's colon: up to the next comma or closing bracket at its own depth.
function valueAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return text.slice(start, i);
      depth--;
    } else if (c === ',' && depth === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

// An expression with every auditValue(...) call cut out.
function withoutAuditValue(expr: string): string {
  let out = expr;
  for (let at = out.search(/\bauditValue\s*\(/); at !== -1; at = out.search(/\bauditValue\s*\(/)) {
    const call = balanced(out, out.indexOf('(', at));
    out = `${out.slice(0, at)}${out.slice(at + out.slice(at).indexOf('(') + call.length)}`;
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  fact: string;
  problem: string;
}

// Every audit fact text of one source: the argument of ctx.audit(...) and the object of `audit: { ... }`.
function facts(code: string): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  for (const m of code.matchAll(/\bctx\s*\.\s*audit\s*\(/g)) out.push({ at: m.index, text: balanced(code, m.index + m[0].length - 1) });
  for (const m of code.matchAll(/\baudit\s*:\s*\{/g)) out.push({ at: m.index, text: balanced(code, m.index + m[0].length - 1) });
  return out;
}

function scan(file: string, text: string, classified: Set<string>): Finding[] {
  const code = blank(text);
  const allowed = ALLOWED[file] ?? {};
  const findings: Finding[] = [];
  const isClassified = (name: string) => !Object.hasOwn(allowed, name) && (classified.has(name) || classified.has(snake(name)));
  const lineOf = (at: number) => code.slice(0, at).split('\n').length;
  for (const fact of facts(code)) {
    const report = (offset: number, key: string, problem: string) => findings.push({ file, line: lineOf(fact.at + offset), fact: key, problem });
    // Shorthand properties: `{ taxCode }` carries the variable's value under a column's name.
    for (const m of fact.text.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) {
      const key = m[1] as string;
      if (isClassified(key)) report(m.index, key, `the key names a classified column; write ${key}: auditValue(...)`);
    }
    for (const m of fact.text.matchAll(/[{,]\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:/g)) {
      const key = (m[1] as string).replace(/^['"]|['"]$/g, '');
      const value = valueAt(fact.text, m.index + m[0].length).trim();
      if (isClassified(key) && !/^auditValue\s*\(/.test(value)) {
        report(m.index, key, 'the key names a classified column and its value is not auditValue(...)');
        continue;
      }
      for (const read of withoutAuditValue(value).matchAll(/\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g)) {
        const column = read[1] as string;
        const expr = `${value.slice(0, read.index).match(/[\w$.?]*$/)?.[0] ?? ''}.${column}`.replace(/^\.+/, '');
        if (Object.hasOwn(allowed, expr)) continue;
        if (isClassified(column)) report(m.index, key, `the value reads the classified column ${column} outside auditValue(...)`);
      }
    }
  }
  return findings;
}

describe('audit facts and classified columns (#1626)', () => {
  const classified = classifiedColumns();
  const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir)));

  it('scans the sources that write audit facts', () => {
    const writers = files.filter((f) => /\bctx\s*\.\s*audit\s*\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f).replaceAll('\\', '/'));
    expect(writers).toEqual(expect.arrayContaining(['packages/kernel/src/parties.ts', 'packages/kernel/src/tax-code.ts', 'packages/kernel/src/org-address.ts', 'packages/kernel/src/legal-entities.ts']));
    for (const column of ['name', 'tax_code', 'address', 'email', 'phone']) expect(classified.has(column)).toBe(true);
  });

  it('finds no fact that carries a classified column past auditValue', () => {
    const findings = files.flatMap((f) => scan(relative(ROOT, f).replaceAll('\\', '/'), readFileSync(f, 'utf8'), classified));
    expect(findings).toEqual([]);
  });

  it('lists only files that exist and facts they still write', () => {
    for (const [file, entries] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const entry of Object.keys(entries)) expect(text.includes(entry), `${file}: ${entry}`).toBe(true);
    }
  });

  it('fails on a fact that skips the helper, and passes one that uses it', () => {
    const check = (source: string) => scan('fixture.ts', source, classified).map((f) => f.fact);
    expect(check('ctx.audit({ previous: before.tax_code, taxCode });')).toEqual(['taxCode', 'previous']);
    expect(check('ctx.audit({ partyId, name: party.name, keepName: keep.name });')).toEqual(['name', 'keepName']);
    expect(check("throw new DomainError('X', 409, 'x', undefined, { audit: { email: input.email } });")).toEqual(['email']);
    expect(check("ctx.audit({ entity: { name: auditValue(T, 'name', name), kind: input.kind } });")).toEqual([]);
    // A comparison that reads a classified column is flagged too: compute it before the call and pass the result.
    expect(check("ctx.audit({ previous: auditValue(T, 'tax_code', before.tax_code), changed: before.tax_code !== taxCode });")).toEqual(['changed']);
    expect(check("ctx.audit({ previous: auditValue(T, 'tax_code', before.tax_code), changed });")).toEqual([]);
    expect(check("ctx.audit({ partyId: row.id, linked: [] }); // name: party.name")).toEqual([]);
  });

  it('replaces a classified value with a marker naming its class, and keeps internal and absent values', () => {
    const table = columns(['id', 'kind'], { name: 'pii', tax_code: 'national_id_if_individual', address: 'contact' });
    expect(auditValue(table, 'name', 'Nguyễn Văn A')).toEqual({ redacted: 'pii' });
    expect(auditValue(table, 'tax_code', '012345678901')).toEqual({ redacted: 'national_id_if_individual' });
    expect(auditValue(table, 'address', { line: 'x' })).toEqual({ redacted: 'contact' });
    expect(auditValue(table, 'kind', 'household')).toBe('household');
    expect(auditValue(table, 'name', null)).toBeNull();
    expect(auditValue(table, 'name', undefined)).toBeUndefined();
    expect(() => auditValue(table as Record<string, DataClass>, 'nmae', 'x')).toThrow(/no column nmae/);
  });
});
