// Audit facts keep no classified value (#1626, plan §4.10): a source scan of every audit fact a command writes, through
// ctx.audit(...) or the audit facts of a DomainError ({ audit: { ... } }). It fails when
// - a fact's key names a column some manifest classifies (anything but internal: pii, contact, payment, national_id,
//   national_id_if_individual, sensitive), in snake_case or camelCase, and its value is not auditValue(...), or
// - a fact's value reads such a column (`before.tax_code`, `row['tax_code']`), reads a row from the database by a
//   computed key (`before[key]`), or names a variable called like one (`{ code: taxCode }`) outside auditValue(...), or
// - an auditValue(T, '<column>', ...) reads another classified column than the one it names, or
// - a fact passed by name, spread into one or handed to ctx.audit whole (#1632) holds a whole row or a classified column
//   a query selects, or is built (from {}, [], a Map or a Set) by writes that break the rules above, or what its
//   declaration holds does (an object written out, a path, a choice's branches, a copy such as .map(...)), or
// - a fact spreads a call: the returns of a function of the same file are read as facts, any other call is a finding,
//   as are facts handed to ctx.audit whole that are neither written out nor a traced declaration, or
// - a fact's whole value is a parameter (a command's `input`) of a function that is not a helper read below, or a name
//   destructured from a classified property (`const { tax_code: code } = before`).
// Casts, parentheses and non-null assertions are seen through. A value computed before the call (a comparison,
// arithmetic, any other call's result) holds none of what it read. A helper that passes its parameter on to ctx.audit
// has every call of it in its file read: as the facts (social's bulk-edit `audit(ctx, result, facts)`, where a call
// whose facts are not written out is a finding) or as a fact's value (`done(reason)`); a helper with no call in its file
// is a finding. Any other destructured name is checked by its name only, and the db tests (audit-facts.db.test.ts and
// each command's own) check what the rows hold.
// auditValue (@crove/kernel-contract) replaces a classified value with a marker naming its class. Facts whose key or value
// names a classified column but hold internal data (an account's name, a command's name) are listed below per file,
// each as the exact fact key and value it covers, with its reason; an entry covers nothing else in its file (#1632).
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

// Facts whose key or value names a classified column but holds internal data, per file, with the reason. An entry is
// `<fact key> <- <value>` (whitespace collapsed; the key itself for a shorthand property) and covers that fact only.
const ALLOWED: Record<string, Record<string, string>> = {
  'packages/kernel/src/agents.ts': { 'proposal_command <- info.name': 'the name of the command a proposal runs' },
  'packages/kernel/src/proposal-reminders.ts': {
    'policy <- input': "the command's whole input, the policy's three day counts",
    'recipients <- Object.fromEntries([...recipients].map(([s, ids]) => [s, ids.length]))': 'how many members each stage reminded, a count per stage',
  },
  'packages/kernel/src/org-address.ts': { 'cleared <- email === null': 'whether the contact address was cleared, a boolean' },
  'modules/crm/src/booking-feed.ts': { 'member <- userId': "the removed member's user id, from the event's parsed payload (zod's .data)" },
  'modules/social/src/review-links.ts': { 'member <- userId': "the removed member's user id, from the event's parsed payload (zod's .data)" },
  'modules/finance/src/accounts.ts': {
    'name <- account.name': "the previous name of an account of the org's chart (crove_finance.account.name, internal)",
    'name <- name': "the new name of an account of the org's chart (crove_finance.account.name, internal)",
  },
  'modules/finance/src/bank.ts': { 'bankAccount <- input.bankAccount': 'the chart account code (112x) the statement is for, not a bank account number' },
  'modules/finance/src/missing-invoices.ts': { 'skipped <- skipped': 'the periods too large to reconcile' },
  'modules/finance/src/portal-list.ts': { 'skipped <- input.skippedCount': "the count of the portal list's skipped rows, not the rows" },
  'modules/social/src/archive.ts': { 'skipped <- result.skipped.map((s) => ({ post_id: s.postId, reason: s.reason }))': 'the post ids left out and why' },
  'modules/social/src/bulk-edit.ts': { 'skipped <- result.skipped.map((s) => ({ post_id: s.postId, reason: s.reason }))': 'the post ids left out and why' },
  'modules/social/src/digest.ts': { 'skipped <- skipped': 'the count of digest mails that failed' },
  'modules/social/src/report-branding.ts': { 'name <- name': "the org's own brand name on its reports (crove_social.report_branding.display_name, internal)" },
  'modules/social/src/report-schedules.ts': { 'recipients <- recipients.length': 'the count of recipients, never their addresses' },
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

// Comments blanked, and the literal text of '...', "..." and `...` strings blanked, line breaks and offsets kept, so
// neither a comment nor a string can open or close a bracket or look like a fact key. The code inside a template's
// ${...} stays, templates nested in it included, since an interpolation can carry a classified value.
function blank(text: string): string {
  let i = 0;
  // Code up to the end of the text or, inside a template's ${...}, up to the } that closes it (not consumed).
  const code = (inTemplate: boolean): string => {
    let out = '';
    let depth = 0;
    while (i < text.length) {
      const c = text[i] as string;
      const next = text[i + 1];
      if (c === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') {
          out += ' ';
          i++;
        }
      } else if (c === '/' && next === '*') {
        const end = text.indexOf('*/', i + 2);
        const stop = end === -1 ? text.length : end + 2;
        out += text.slice(i, stop).replace(/[^\n]/g, ' ');
        i = stop;
      } else if (c === "'" || c === '"') {
        out += c;
        i++;
        while (i < text.length && text[i] !== c && text[i] !== '\n') {
          out += text[i] === '\\' ? '  ' : ' ';
          i += text[i] === '\\' ? 2 : 1;
        }
        if (i < text.length) out += text[i++];
      } else if (c === '`') {
        out += template();
      } else if (inTemplate && c === '}' && depth === 0) {
        return out;
      } else {
        if (inTemplate && c === '{') depth++;
        if (inTemplate && c === '}') depth--;
        out += c;
        i++;
      }
    }
    return out;
  };
  // A template literal from its opening backtick: its text blanked, each ${...} kept as code.
  const template = (): string => {
    let out = '`';
    i++;
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') {
        out += text[i + 1] === '\n' ? ' \n' : '  ';
        i += 2;
      } else if (text[i] === '$' && text[i + 1] === '{') {
        out += '${';
        i += 2;
        out += code(true);
        if (i < text.length) out += text[i++];
      } else {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
    }
    if (i < text.length) out += text[i++];
    return out;
  };
  return code(false);
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

// The expression from `start`: up to the next comma, semicolon or closing bracket at its own depth (a semicolon ends a
// statement, so an initializer or an assignment's right side stops there too).
function valueAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return text.slice(start, i);
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

// An expression with every auditValue(...) call cut out (blanked, so offsets keep).
function withoutAuditValue(expr: string): string {
  let out = expr;
  for (let at = out.search(/\bauditValue\s*\(/); at !== -1; at = out.search(/\bauditValue\s*\(/)) {
    const open = out.indexOf('(', at);
    const call = balanced(out, open);
    out = `${out.slice(0, at)}${' '.repeat(open - at + call.length)}${out.slice(open + call.length)}`;
  }
  return out;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

// A query whose result a name holds: what it selects or returns is what a fact that holds it carries.
const QUERY = /\b(?:selectFrom|updateTable|insertInto|deleteFrom)\s*\(|^(?:await\s+)?sql\b/;
// An empty object, array, Map or Set, filled by the writes that follow it.
const BUILT = /^(?:\{\s*\}|\[\s*\]|new\s+(?:Map|Set)\s*(?:<[^>]*>)?\s*\(\s*\))(?:\s+as\s+[^]*)?$/;
// A call whose result carries the values it reads (a copy, a projection, a string of them); any other call, a comparison
// or arithmetic computes a new value.
const PASS_THROUGH =
  /(?:^|\.)(?:map|flatMap|filter|slice|concat|trim|trimStart|trimEnd|toLowerCase|toUpperCase|normalize|join|sort|toSorted|toString|padStart|padEnd|at|find|values|entries|replace|replaceAll|split|substring|substr|toLocaleLowerCase|toLocaleUpperCase)$|^(?:String|Object\.fromEntries|Object\.assign|Object\.values|Object\.entries|JSON\.stringify|Array\.from|structuredClone)$/;
// A variable copied whole by a pass-through method: `raw.trim()`, `list.slice()`, `names.join(',')`.
const COPY_OF =
  /(?<![\w$.])([A-Za-z_$][\w$]*)\s*!?\s*(?:\?\.|\.)\s*(?:filter|slice|concat|trim|trimStart|trimEnd|toLowerCase|toUpperCase|normalize|join|sort|toSorted|toString|padStart|padEnd|at|find|values|entries|replace|replaceAll|split|substring|substr|toLocaleLowerCase|toLocaleUpperCase)\s*\(/g;
// Words an expression may hold that are not variables.
const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'await', 'new', 'typeof', 'void', 'as', 'in', 'of', 'instanceof', 'satisfies', 'const', 'this']);

const escape = (name: string) => name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

// The part of a name's initializer whose values the name holds: the branches of a choice, the whole of a path, a
// literal or a pass-through call, and null for a value computed from what it reads (`a !== b`, `count + 1`, `f(x)`).
function heldPart(init: string): string | null {
  // A non-null assertion (`before!.tax_code`) is not a negation: it goes before the operators are read.
  const expr = init
    .replace(/^await\s+/, '')
    .replace(/\s+(?:as|satisfies)\s+[^]*$/, '')
    .replace(/([\w$)\]])!(?!=)/g, '$1');
  let depth = 0;
  let top = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i] as string;
    if ('([{'.includes(c)) {
      if (depth === 0) top += c;
      depth++;
    } else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) top += c;
    } else if (depth === 0) {
      // A choice at the top: its branches are what the name holds, whatever the condition compares.
      if (c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?' && expr[i - 1] !== '?') return expr.slice(i + 1);
      top += c;
    }
  }
  if (/===|!==|==|!=|<=|>=|[<>*%]|(?<![=!<>])!(?!=)|\s-\s/.test(top.replace(/\?\?|=>/g, ' '))) return null;
  const call = /([A-Za-z_$][\w$.]*)\s*(?:\?\.)?\(\)\s*!?$/.exec(top);
  if (call && !PASS_THROUGH.test(call[1] as string)) return null;
  return expr;
}

// Whether an expression is an object written out, or a choice between objects written out (`x ? { a } : { b }`).
// A choice with any other branch (`x ? { a } : before`) is a value, so each branch is traced.
function objectish(expr: string): boolean {
  if (/^\(?\s*\{/.test(expr)) return true;
  const held = heldPart(expr);
  if (held === null || held === expr.replace(/^await\s+/, '')) return false;
  const branches: string[] = [];
  let depth = 0;
  let branch = '';
  for (let i = 0; i < held.length; i++) {
    const c = held[i] as string;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ':' && depth === 0) {
      branches.push(branch);
      branch = '';
    } else branch += c;
  }
  return [...branches, branch].every((b) => /^\s*\(?\s*\{/.test(b));
}

// An expression without the parentheses, casts and non-null assertions around it: `(before as Row)!` is `before`.
function unwrap(expr: string): string {
  let out = expr.trim();
  for (;;) {
    let next = out.replace(/!+$/, '').trim();
    if (next.startsWith('(') && balanced(next, 0) === next) next = next.slice(1, -1).trim();
    next = /^([A-Za-z_$][\w$.]*)!?\s+(?:as|satisfies)\s+/.exec(next)?.[1] ?? next;
    if (next === out) return out;
    out = next;
  }
}

interface Finding {
  file: string;
  line: number;
  fact: string;
  problem: string;
}

// A function of the file with a block body: its name (none for an arrow passed as an argument) and parameters.
interface Fn {
  name: string;
  params: string[];
  start: number;
  end: number;
}

// A function that passes one of its parameters on to ctx.audit: as the facts (`...facts`, `ctx.audit(facts)`), or as a
// fact's value (`{ reason }`).
interface Wrapper {
  fn: Fn;
  param: number;
  whole: boolean;
}

function scan(file: string, text: string, classified: Set<string>): Finding[] {
  const code = blank(text);
  const allowed = ALLOWED[file] ?? {};
  const findings: Finding[] = [];
  const isClassified = (name: string) => classified.has(name) || classified.has(snake(name));
  const lineOf = (at: number) => code.slice(0, at).split('\n').length;
  const reporter = (at: number, fact: string) => (problem: string) => {
    findings.push({ file, line: lineOf(at), fact, problem });
  };
  // The string literal at offset `at` (`code` blanks its text, so it is read from `text`).
  const literalAt = (at: number) => /^\s*(['"])([^'"\n]*)\1/.exec(text.slice(at))?.[2];

  // The functions of this file: `function name(...) {`, and arrows with a block body (`const name = (...) => {`).
  const functions: Fn[] = [];
  const params = (list: string) => splitTop(list.slice(1, -1)).map((p) => p.trim().replace(/^\.\.\./, '').split(/[:=?]/)[0]?.trim() ?? '');
  for (const m of code.matchAll(/\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^>]*>)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const list = balanced(code, open);
    const brace = /^\s*(?::[^{]*)?\{/.exec(code.slice(open + list.length));
    if (!brace) continue;
    const start = open + list.length + brace[0].length - 1;
    functions.push({ name: m[1] ?? '', params: params(list), start, end: start + balanced(code, start).length });
  }
  for (const m of code.matchAll(/=>\s*\{/g)) {
    const start = (m.index ?? 0) + m[0].length - 1;
    const before = code.slice(0, m.index);
    let head: number;
    let list: string[];
    const close = before.search(/\)\s*(?::[^()=;]*)?\s*$/);
    if (close !== -1) {
      let depth = 0;
      head = close;
      for (; head >= 0; head--) {
        if (code[head] === ')') depth++;
        else if (code[head] === '(' && --depth === 0) break;
      }
      list = params(code.slice(head, close + 1));
    } else {
      const single = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
      if (!single) continue;
      head = single.index;
      list = [single[1] as string];
    }
    const name = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?$/.exec(code.slice(0, head))?.[1] ?? '';
    functions.push({ name, params: list, start, end: start + balanced(code, start).length });
  }
  const enclosingAll = (at: number) => functions.filter((f) => f.start <= at && at < f.end).sort((a, b) => b.start - a.start);
  // A declaration at `decl` is in scope at `at` when the innermost block around it (a function body, an if, a loop)
  // also holds `at`.
  const inScope = (decl: number, at: number) => {
    let depth = 0;
    for (let i = decl - 1; i >= 0; i--) {
      if (code[i] === '}') depth++;
      else if (code[i] === '{' && depth-- === 0) return at < i + balanced(code, i).length;
    }
    return true;
  };
  // Declarations already traced for the facts being read, so a name met again (or a chain of names) is read once per call.
  const traced = new Set<string>();
  // Functions whose returns a spread of their call reads as facts.
  const spreadRead = new Set<Fn>();
  // Where the facts being read are written (the ctx.audit call, or a wrapper's call).
  let useAt = 0;
  // The declaration of `name` in scope at `at`: where its initializer starts, and the initializer.
  const declaration = (name: string, at: number) => {
    const decl = [...code.slice(0, at).matchAll(new RegExp(`\\b(?:const|let|var)\\s+${escape(name)}\\s*(?::[^=;]+)?=(?![=>])\\s*`, 'g'))]
      .filter((d) => inScope(d.index ?? 0, at))
      .at(-1);
    if (!decl) return undefined;
    const from = (decl.index ?? 0) + decl[0].length;
    return { index: decl.index ?? 0, from, init: valueAt(code, from).trim() };
  };
  const isRow = (name: string, at: number) => {
    const decl = declaration(name, at);
    return decl !== undefined && QUERY.test(decl.init);
  };

  // One fact: its key, then its value. A listed `<key> <- <value>` passes.
  const checkFact = (key: string, value: string, at: number, depth = 0) => {
    const trimmed = value.trim();
    if (Object.hasOwn(allowed, `${key} <- ${collapse(trimmed)}`)) return;
    const flag = reporter(at, key);
    if (isClassified(key) && !/^auditValue\s*\(/.test(trimmed)) {
      flag('the key names a classified column and its value is not auditValue(...)');
      return;
    }
    // An object written out has each of its keys read as a fact of its own.
    if (trimmed.startsWith('{')) return;
    checkValue(trimmed, at, flag, depth);
  };

  // A value: what it reads, the variables it names, the auditValue calls in it, and what a name of the file holds.
  const checkValue = (value: string, at: number, flag: (problem: string) => void, depth: number) => {
    const start = code.indexOf(value, Math.max(0, at - 1));
    const bare = withoutAuditValue(value);
    for (const read of bare.matchAll(/\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g)) {
      if (isClassified(read[1] as string)) flag(`the value reads the classified column ${read[1]} outside auditValue(...)`);
    }
    // A read by the column's name: `row['tax_code']`.
    for (const read of bare.matchAll(/\[\s*['"]/g)) {
      const column = start === -1 ? undefined : literalAt(start + (read.index ?? 0) + 1);
      if (column && isClassified(column)) flag(`the value reads the classified column ${column} by name outside auditValue(...)`);
    }
    // A read of a row from the database by a computed key (`before[key]`): it may be any column.
    for (const read of bare.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*!?\s*\[\s*(?![\d'"\]\s])/g)) {
      if (isRow(read[1] as string, at)) flag(`the value reads a field of the row ${read[1]} by a computed key outside auditValue(...)`);
    }
    // A variable named like a classified column (`{ code: taxCode }`); object keys and member reads aside.
    for (const name of variables(bare)) {
      if (isClassified(name)) flag(`the value is ${name}, named like a classified column, outside auditValue(...)`);
    }
    // auditValue(T, '<column>', <value>) reading another classified column than the one it names.
    for (const call of value.matchAll(/\bauditValue\s*\(/g)) {
      const open = (call.index ?? 0) + call[0].length - 1;
      const args = splitTop(balanced(value, open).slice(1, -1));
      const column = start === -1 ? undefined : literalAt(start + open + 1 + (args[0]?.length ?? 0) + 1);
      if (!column || args.length < 3) continue;
      for (const read of (args[2] as string).matchAll(/\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g)) {
        const other = read[1] as string;
        if (isClassified(other) && snake(other) !== column) flag(`auditValue names ${column} but reads ${other}`);
      }
    }
    // Each variable in the part of the value it holds (a choice's branches, a copy, not a comparison) is traced.
    const held = heldPart(value);
    if (depth < 4 && held !== null) {
      const whole = unwrap(value);
      for (const name of variables(withoutAuditValue(held))) if (!isClassified(name)) checkName(name, at, flag, depth + 1, name === whole);
      // A copy of a variable (`raw.trim()`, `list.slice()`) holds what the variable holds; a projection (`.map(...)`)
      // holds what its callback returns, read above.
      for (const copy of withoutAuditValue(held).matchAll(COPY_OF)) checkName(copy[1] as string, at, flag, depth + 1, false);
      // A projection that returns its element whole (`rows.map((r) => r)`, `.map((r) => ({ ...r }))`) is a copy too.
      for (const m of withoutAuditValue(held).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*(?:map|flatMap)\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?::[^)=]*)?\)?\s*=>/g)) {
        const body = unwrap(valueAt(held, (m.index ?? 0) + m[0].length));
        const element = escape(m[2] as string);
        if (body === m[2] || new RegExp(`\\.\\.\\.\\s*${element}\\b(?!\\s*(?:[.[]|\\?\\.))`).test(body)) checkName(m[1] as string, at, flag, depth + 1, false);
      }
    }
  };

  // A fact that is a variable of this file. A query's result is checked by the columns it selects (a whole row is
  // refused); an empty object, array, Map or Set by every write to it; an object written out key by key; any other by
  // the part of its initializer it holds. A parameter that is the whole value is checked at the calls of its function
  // when that function is a wrapper, and is a finding otherwise (a command's `input` handed over whole). A destructured
  // name is a finding when it renames a classified property, and is otherwise checked by its name only. Returns
  // whether the name was traced.
  const checkName = (name: string, at: number, flag: (problem: string) => void, depth: number, whole = true): boolean => {
    const owner = enclosingAll(at).find((f) => f.params.includes(name));
    if (owner) {
      // A function whose returns a spread reads has its parameters bound to the call's arguments, read at the call.
      if (whole && !spreadRead.has(owner) && !wrappers.some((w) => w.fn === owner && owner.params[w.param] === name)) {
        flag(`the value is the parameter ${name}, which the scan cannot trace; write the facts out`);
      }
      return true;
    }
    const decl = declaration(name, at);
    if (!decl) {
      for (const d of code.slice(0, at).matchAll(/\b(?:const|let|var)\s*\{/g)) {
        if (!inScope(d.index ?? 0, at)) continue;
        const pattern = balanced(code, (d.index ?? 0) + d[0].length - 1);
        const renamed = new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*${escape(name)}\\b(?!\\s*[:{])`).exec(pattern)?.[1];
        if (renamed && isClassified(renamed)) {
          flag(`${name} is the classified column ${renamed}, renamed by destructuring`);
          return true;
        }
      }
      return false;
    }
    const { from, init } = decl;
    const built =BUILT.test(init) || /^new\s+(?:Map|Set)\s*</.test(init);
    // A container is read up to the fact's own call (`useAt`), even when reached through another declaration.
    const end = Math.max(at, useAt);
    const key = `${decl.index}:${built ? end : ''}`;
    if (traced.has(key)) return true;
    traced.add(key);
    if (QUERY.test(init)) {
      if (/\b(?:selectAll|returningAll)\s*\(/.test(init) || /^(?:await\s+)?sql\b/.test(init)) {
        flag(`${name} is a whole row from the database; pass the columns it needs, classified ones through auditValue(...)`);
        return true;
      }
      for (const pick of init.matchAll(/\.\s*(?:select|returning)\s*\(/g)) {
        const open = (pick.index ?? 0) + pick[0].length - 1;
        const list = balanced(init, open);
        for (const q of list.matchAll(/['"]/g)) {
          if ((q.index ?? 0) > 0 && /['"]/.test(list[(q.index ?? 0) - 1] as string)) continue;
          const lit = literalAt(from + open + (q.index ?? 0));
          const column = lit?.split(/\s+as\s+/i)[0]?.split('.').at(-1);
          if (column && isClassified(column)) flag(`${name} holds the classified column ${column} from the database`);
        }
      }
      return true;
    }
    if (built) {
      const scope = code.slice(from, end);
      // A write to another variable of the same name (in a nested function or block) is not a write to this one.
      const ours = (offset: number) => declaration(name, from + offset)?.index === decl.index;
      for (const w of scope.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}\\s*(\\[[^\\]]*\\]|\\.\\s*[A-Za-z_$][\\w$]*)\\s*=(?![=>])\\s*`, 'g'))) {
        if (!ours(w.index ?? 0)) continue;
        const target = w[1] as string;
        const key = target.startsWith('[') ? literalAt(from + (w.index ?? 0) + w[0].indexOf('[') + 1) : target.replace(/^\.\s*/, '');
        const rhs = valueAt(code, from + (w.index ?? 0) + w[0].length).trim();
        if (key && isClassified(key) && !/^auditValue\s*\(/.test(rhs)) flag(`${name}.${key} is a classified column and its value is not auditValue(...)`);
        // A computed key is stored too: `previous[party.email] = true` carries the address.
        if (target.startsWith('[') && key === undefined) checkValue(target.slice(1, -1).trim(), from + (w.index ?? 0) + w[0].indexOf('[') + 1, flag, depth);
        if (objectish(rhs)) checkObject(rhs, from + (w.index ?? 0) + w[0].length, depth);
        else checkValue(rhs, from + (w.index ?? 0) + w[0].length, flag, depth);
      }
      for (const w of scope.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}\\s*\\.\\s*(push|set|add|unshift)\\s*\\(`, 'g'))) {
        if (!ours(w.index ?? 0)) continue;
        const open = from + (w.index ?? 0) + w[0].length - 1;
        const args = splitTop(balanced(code, open).slice(1, -1));
        // A Map's key names the entry, like a bracket write: a classified column's name needs its value through auditValue.
        if (w[1] === 'set') {
          const key = literalAt(code.indexOf(args[0] ?? '', open));
          const rhs = args[1]?.trim() ?? '';
          if (key && isClassified(key) && !/^auditValue\s*\(/.test(rhs)) flag(`${name}.${key} is a classified column and its value is not auditValue(...)`);
          args.shift();
        }
        for (const arg of args) {
          if (objectish(arg.trim())) checkObject(arg.trim(), code.indexOf(arg.trim(), open), depth);
          else checkValue(arg.trim(), open, flag, depth);
        }
      }
      return true;
    }
    if (objectish(init)) {
      checkObject(init, from, depth);
      return true;
    }
    const held = heldPart(init);
    if (held !== null) checkValue(held.trim(), from + init.indexOf(held.trim()), flag, depth);
    return true;
  };

  // Every key and value of a fact object's text, nested objects included, and its spreads.
  const checkObject = (obj: string, start: number, depth = 0) => {
    // Shorthand properties: `{ taxCode }` carries the variable's value under a column's name.
    for (const m of obj.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) checkFact(m[1] as string, m[1] as string, start + (m.index ?? 0), depth);
    for (const m of obj.matchAll(/[{,]\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:/g)) {
      const key = (m[1] as string).replace(/^['"]|['"]$/g, '');
      checkFact(key, valueAt(obj, (m.index ?? 0) + m[0].length), start + (m.index ?? 0) + m[0].length, depth);
    }
    // A computed key (`{ [field]: value }`): its value is read like any other.
    for (const m of obj.matchAll(/[{,]\s*\[/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const after = open + balanced(obj, open).length;
      const colon = /^\s*:/.exec(obj.slice(after));
      if (!colon) continue;
      // The key is stored too: `{ [party.email]: true }` carries the address.
      const key = obj.slice(open + 1, after - 1).trim();
      checkValue(key, start + open + 1, reporter(start + open, `[${key}]`), depth);
      checkFact(`[${key}]`, valueAt(obj, after + colon[0].length), start + after + colon[0].length, depth);
    }
    for (const m of obj.matchAll(/[{,]\s*\.\.\.\s*/g)) {
      const at = start + (m.index ?? 0) + m[0].length;
      const spread = unwrap(valueAt(obj, (m.index ?? 0) + m[0].length));
      // An object written out in place (`...(x ? { a } : {})`) is read with the rest of the fact.
      if (objectish(spread)) continue;
      const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(spread);
      if (call) checkSpreadCall(call[1] as string, spread, at, depth);
      else if (/\)\s*$/.test(spread)) reporter(at, `...${spread}`)('the facts spread the result of a call the scan cannot read; write them out');
      else checkFact(`...${spread}`, spread, at, depth);
    }
  };

  // A spread of a call to a function of this file: what it returns is read as facts, and its arguments as values.
  const checkSpreadCall = (name: string, spread: string, at: number, depth: number) => {
    const flag = reporter(at, `...${name}(...)`);
    const open = spread.indexOf('(');
    for (const arg of splitTop(balanced(spread, open).slice(1, -1))) checkValue(arg.trim(), at, flag, depth);
    const bodies: Array<{ text: string; at: number }> = [];
    const fn = functions.find((f) => f.name === name);
    if (fn) spreadRead.add(fn);
    if (fn) {
      for (const r of code.slice(fn.start, fn.end).matchAll(/\breturn\s+/g)) {
        const from = fn.start + (r.index ?? 0) + r[0].length;
        bodies.push({ text: valueAt(code, from).trim(), at: from });
      }
    } else {
      const decl = new RegExp(`\\bconst\\s+${escape(name)}\\s*(?::[^=]*)?=`).exec(code);
      const arrow = decl ? code.indexOf('=>', decl.index) : -1;
      if (arrow !== -1) {
        const from = arrow + 2 + (/^\s*/.exec(code.slice(arrow + 2))?.[0].length ?? 0);
        bodies.push({ text: valueAt(code, from).trim(), at: from });
      }
    }
    if (bodies.length === 0 || depth >= 4) {
      flag(`the facts spread ${name}(...), whose result the scan cannot read; write them out`);
      return;
    }
    for (const body of bodies) {
      if (objectish(body.text)) checkObject(body.text, body.at, depth + 1);
      else checkFact(`...${name}(...)`, body.text, body.at, depth + 1);
    }
  };

  // The audit facts of this file: ctx.audit(...)'s argument and `audit: { ... }`.
  const sites: Array<{ at: number; arg: string }> = [];
  for (const m of code.matchAll(/\bctx\s*\.\s*audit\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    sites.push({ at: open, arg: balanced(code, open) });
  }
  for (const m of code.matchAll(/\baudit\s*:\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    sites.push({ at: open, arg: `(${balanced(code, open)})` });
  }
  const wrappers: Wrapper[] = [];
  for (const site of sites) {
    useAt = site.at;
    traced.clear();
    const inner = unwrap(site.arg.slice(1, -1));
    // A parameter inside auditValue(...) is masked there, so it does not make its function a wrapper.
    const audited = withoutAuditValue(site.arg);
    for (const fn of enclosingAll(site.at)) {
      if (!fn.name) continue;
      fn.params.forEach((param, i) => {
        if (!/^[A-Za-z_$][\w$]*$/.test(param) || param === 'ctx') return;
        const p = escape(param);
        const whole = inner === param || new RegExp(`\\.\\.\\.\\s*${p}\\b(?!\\s*(?:[.([]|\\?\\.))`).test(audited);
        const value = new RegExp(`(?<![\\w$.])${p}\\b(?!\\s*(?:[.:([]|\\?\\.))`).test(audited);
        if ((whole || value) && !wrappers.some((w) => w.fn === fn && w.param === i)) wrappers.push({ fn, param: i, whole });
      });
    }
    // An argument written out, or a choice between written-out objects, is read as facts; a name is traced; anything
    // else cannot be attributed.
    if (objectish(inner)) checkObject(site.arg, site.at);
    else if (/^[A-Za-z_$][\w$]*$/.test(inner)) {
      const flag = reporter(site.at, inner);
      if (!checkName(inner, site.at, flag, 1)) flag('the facts are a name the scan cannot trace; write them out');
    } else reporter(site.at, inner)('the facts are not written out; pass an object literal');
  }
  // Each call of a wrapper in this file: the facts it passes are read as the wrapper's own. A wrapper with no call here
  // (exported, or passed by reference) cannot be read.
  for (const w of wrappers) {
    let calls = 0;
    for (const call of code.matchAll(new RegExp(`(?<![\\w$.])${escape(w.fn.name)}\\s*\\(`, 'g'))) {
      if (/\bfunction\s*$/.test(code.slice(0, call.index))) continue;
      calls++;
      const open = (call.index ?? 0) + call[0].length - 1;
      const arg = splitTop(balanced(code, open).slice(1, -1))[w.param]?.trim() ?? '';
      const at = arg === '' ? open : code.indexOf(arg, open);
      useAt = at;
      traced.clear();
      const flag = reporter(at, `${w.fn.name}(...)`);
      if (!w.whole) checkValue(arg, at, flag, 0);
      else if (arg.startsWith('{')) checkObject(arg, at);
      else flag(`${w.fn.name} passes its argument to ctx.audit; write the facts out as an object literal at the call`);
    }
    if (calls === 0) {
      reporter(w.fn.start, `${w.fn.name}(...)`)(`${w.fn.name} passes its parameter ${w.fn.params[w.param]} to ctx.audit and has no call in this file to read`);
    }
  }
  return findings;
}

// The variables an expression names: object keys, member reads, calls and keywords aside.
function variables(expr: string): string[] {
  const keysBlanked = expr.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, (_, a: string, k: string, b: string) => `${a}${' '.repeat(k.length)}${b}`);
  return [...keysBlanked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b(?!\s*(?:[.([]|\?\.|!\s*[.[]))/g)].map((m) => m[1] as string).filter((n) => !KEYWORDS.has(n));
}

// A list split at its top-level commas (blanked code, so no string holds a comma).
function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let item = '';
  for (const c of list) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      out.push(item);
      item = '';
    } else item += c;
  }
  return item.trim() === '' ? out : [...out, item];
}

describe('audit facts and classified columns (#1626, #1632)', () => {
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
      const code = collapse(blank(readFileSync(join(ROOT, file), 'utf8')));
      for (const entry of Object.keys(entries)) {
        const [key, value] = entry.split(' <- ') as [string, string];
        const shorthand = key === value && new RegExp(`[{,]\\s*${key}\\s*[,}]`).test(code);
        expect(shorthand || code.includes(`${key}: ${value}`), `${file}: ${entry}`).toBe(true);
      }
    }
  });

  it('fails on a fact that skips the helper, and passes one that uses it', () => {
    const check = (source: string) => scan('fixture.ts', source, classified).map((f) => f.fact);
    expect(check('ctx.audit({ previous: before.tax_code, taxCode });')).toEqual(['taxCode', 'previous']);
    expect(check('ctx.audit({ partyId, name: party.name, keepName: keep.name });')).toEqual(['name', 'keepName']);
    expect(check("throw new DomainError('X', 409, 'x', undefined, { audit: { email: input.email } });")).toEqual(['email']);
    expect(check("ctx.audit({ entity: { name: auditValue(T, 'name', name), kind: input.kind } });")).toEqual([]);
    // A comparison that reads a classified column is flagged too: compute it before the call and pass the result.
    expect(check("ctx.audit({ previous: auditValue(T, 'tax_code', before.tax_code), changed: before.tax_code !== taxCode });")).toEqual(['changed', 'changed']);
    expect(check("ctx.audit({ previous: auditValue(T, 'tax_code', before.tax_code), changed });")).toEqual([]);
    expect(check('ctx.audit({ partyId: row.id, linked: [] }); // name: party.name')).toEqual([]);
    // A template's text cannot open a bracket or pose as a key; the code in its ${...} is still scanned, nested too.
    expect(check('ctx.audit({ msg: `) { name: x ]`, partyId });')).toEqual([]);
    expect(check('ctx.audit({ msg: `Gộp ${party.name} vào ${`(${keep.name})`}`, partyId });')).toEqual(['msg', 'msg']);
    expect(check('ctx.audit({ msg: `${auditValue(T, "name", party.name)}`, partyId });')).toEqual([]);
  });

  it('fails on facts built before the call, spread, renamed or read by name (#1632)', () => {
    const check = (source: string) => scan('fixture.ts', source, classified).map((f) => `${f.fact}: ${f.problem}`);
    // Built in a loop and passed by name: each write is checked.
    const loop = (rhs: string) =>
      [
        "const before = await ctx.trx.selectFrom('crove_kernel.party').select(['id', 'kind']).executeTakeFirstOrThrow();",
        'const previous: Record<string, unknown> = {};',
        `for (const field of changed) previous[field] = ${rhs};`,
        'ctx.audit({ partyId: before.id, previous });',
      ].join('\n');
    expect(check(loop('auditValue(PARTY, field, before[field])'))).toEqual([]);
    expect(check(loop('before[field]'))).toEqual(['previous: the value reads a field of the row before by a computed key outside auditValue(...)']);
    // An index into something that is not a row (`input.items[i]`, a const map of names) is not a column read.
    expect(check("const field = { tax_code: 'taxCode' } as const;\nctx.audit({ changed: changed.map((k) => field[k]), item: input.items[i] });")).toEqual([]);
    // Objects pushed or set into a built container are read as facts; a Map's key that names a column needs auditValue.
    expect(check('const facts = [];\nfacts.push({ email: value });\nctx.audit({ facts });')).toEqual(['email: the key names a classified column and its value is not auditValue(...)']);
    expect(check("const m = new Map<string, string>();\nm.set('tax_code', before.code);\nctx.audit({ m });")).toEqual(['m: m.tax_code is a classified column and its value is not auditValue(...)']);
    expect(check('ctx.audit({ previous: { [field]: before.tax_code } });')).toEqual(['[field]: the value reads the classified column tax_code outside auditValue(...)']);
    expect(check('ctx.audit({ previous: { [party.email]: true } });')).toEqual(['[party.email]: the value reads the classified column email outside auditValue(...)']);
    // A function whose returns a spread reads takes its parameters from the call, whose arguments are read there.
    expect(check('function targetFact(targetId: string) { return { targetId }; }\nctx.audit({ ...targetFact(input.targetId) });')).toEqual([]);
    expect(check('function targetFact(targetId: string) { return { targetId }; }\nctx.audit({ ...targetFact(party.email) });')).toEqual([
      '...targetFact(...): the value reads the classified column email outside auditValue(...)',
    ]);
    expect(check('const facts = {};\nfunction unrelated() { const facts = {}; facts.email = party.email; }\nctx.audit({ facts });')).toEqual([]);
    expect(check("const m = new Map<string, number>();\nm.set(column, rows);\nctx.audit({ erased: Object.fromEntries(m) });")).toEqual([]);
    expect(check(loop('before.tax_code'))).toEqual(['previous: the value reads the classified column tax_code outside auditValue(...)']);
    expect(check(["const values = [];", 'values.push(party.email);', 'ctx.audit({ values });'].join('\n'))).toEqual(['values: the value reads the classified column email outside auditValue(...)']);
    expect(check(["const previous = {};", "previous['tax_code'] = before.code;", 'ctx.audit({ previous });'].join('\n'))).toEqual([
      'previous: previous.tax_code is a classified column and its value is not auditValue(...)',
    ]);
    // A whole row, spread or passed by name.
    const row = "const before = await ctx.trx.selectFrom('crove_kernel.party').selectAll().executeTakeFirstOrThrow();";
    expect(check(`${row}\nctx.audit({ ...before });`)).toHaveLength(1);
    expect(check(`${row}\nctx.audit({ previous: before });`)).toHaveLength(1);
    expect(check(`${row}\nctx.audit(before);`)).toHaveLength(1);
    // A spread of a name is read as what the name holds; of an object written out, with the rest of the fact.
    expect(check(['const extra = { code: party.tax_code };', 'ctx.audit({ id, ...extra });'].join('\n'))).toEqual([
      'code: the value reads the classified column tax_code outside auditValue(...)',
    ]);
    // A query's result carries the columns it selects or returns.
    const picked = "const before = await ctx.trx.selectFrom('crove_kernel.party').select(['id', 'p.tax_code as code']).executeTakeFirstOrThrow();";
    expect(check(`${picked}\nctx.audit({ previous: before });`)).toEqual(['previous: before holds the classified column tax_code from the database']);
    expect(check("const done = await ctx.trx.updateTable('t').set({ a: 1 }).returning('id').execute();\nctx.audit({ done });")).toEqual([]);
    // A spread of a call: a function of the file has what it returns read as facts; another's result cannot be read.
    const fact = "const targetFact = (visibility: string, targetId: string) => (visibility === 'org' ? { targetId } : { target: 'private' });";
    expect(check(`${fact}\nctx.audit({ noteId, ...targetFact(note.visibility, input.targetId) });`)).toEqual([]);
    expect(check('const leak = (p: P) => ({ email: p.email });\nctx.audit({ noteId, ...leak(party) });')).toEqual([
      'email: the key names a classified column and its value is not auditValue(...)',
    ]);
    expect(check('ctx.audit({ noteId, ...imported(party) });')).toEqual(['...imported(...): the facts spread imported(...), whose result the scan cannot read; write them out']);
    expect(check('ctx.audit({ noteId, ...party.toFacts() });')).toEqual(['...party.toFacts(): the facts spread the result of a call the scan cannot read; write them out']);
    // A value computed before the call holds none of what it read; one copied, chosen or projected holds all of it.
    expect(check('const changed = before.tax_code !== taxCode;\nctx.audit({ changed });')).toEqual([]);
    expect(check('const partyId = await partyFor(ctx, booking.email);\nctx.audit({ partyId });')).toEqual([]);
    expect(check('const previous = flag ? before.tax_code : null;\nctx.audit({ previous });')).toEqual(['previous: the value reads the classified column tax_code outside auditValue(...)']);
    expect(check('const emails = rows.map((r) => r.email);\nctx.audit({ emails });')).toEqual(['emails: the value reads the classified column email outside auditValue(...)']);
    // A declaration in another function is not the one the fact names.
    expect(check('function a() { const code = row.tax_code; }\nfunction b(ctx: C) { ctx.audit({ code }); }')).toEqual([]);
    // Facts passed whole are written out or traced to a declaration.
    expect(check('const { facts } = input;\nctx.audit(facts);')).toEqual(['facts: the facts are a name the scan cannot trace; write them out']);
    expect(check('ctx.audit(factsOf(party));')).toEqual(['factsOf(party): the facts are not written out; pass an object literal']);
    // A command's input handed over whole, spread or as a value cannot be traced.
    const handler = (facts: string) => `defineCommand({ handler: async (ctx, input) => {\n  ctx.audit(${facts});\n} });`;
    expect(check(handler('input'))).toEqual(['input: the value is the parameter input, which the scan cannot trace; write the facts out']);
    expect(check(handler('{ id: 1, ...input }'))).toEqual(['...input: the value is the parameter input, which the scan cannot trace; write the facts out']);
    expect(check(handler('{ previous: input }'))).toEqual(['previous: the value is the parameter input, which the scan cannot trace; write the facts out']);
    expect(check(handler('{ count: input.items.length }'))).toEqual([]);
    // Casts, parentheses and non-null assertions do not hide what a name holds.
    for (const value of ['before as Row', 'before as Record<string, unknown>', '(before)', 'before!']) {
      expect(check(`${row}\nctx.audit({ previous: ${value} });`), value).toHaveLength(1);
    }
    expect(check(`${row}\nctx.audit({ id: 1, ...(before as object) });`)).toHaveLength(1);
    expect(check('const code = before!.tax_code;\nctx.audit({ code });')).toEqual(['code: the value reads the classified column tax_code outside auditValue(...)']);
    expect(check("const code = before.tax_code.replace(/-/g, '');\nctx.audit({ code });")).toEqual(['code: the value reads the classified column tax_code outside auditValue(...)']);
    // A classified property renamed by destructuring, and a name traced through a choice or a copy.
    expect(check('const { tax_code: code } = before;\nctx.audit({ code });')).toEqual(['code: code is the classified column tax_code, renamed by destructuring']);
    expect(check('const raw = party.tax_code;\nconst previous = ok ? raw : null;\nctx.audit({ previous });')).toEqual([
      'previous: the value reads the classified column tax_code outside auditValue(...)',
    ]);
    for (const copy of ['raw.trim()', 'raw.slice()', "raw.split('-').join('')"]) {
      expect(check(`const raw = party.tax_code;\nconst previous = ${copy};\nctx.audit({ previous });`), copy).toEqual([
        'previous: the value reads the classified column tax_code outside auditValue(...)',
      ]);
    }
    // A choice with a row in one branch, a container written after another object holds it, and a whole-element copy.
    expect(check(`${row}\nconst facts = flag ? { id: 1 } : before;\nctx.audit(facts);`)).toHaveLength(1);
    expect(check('const previous = {};\nconst facts = { previous };\nprevious.code = party.tax_code;\nctx.audit(facts);')).toEqual([
      'previous: the value reads the classified column tax_code outside auditValue(...)',
    ]);
    expect(check(`${picked.replace('before', 'rows')}\nconst copied = rows.map((r) => r);\nctx.audit({ copied });`)).toEqual([
      'copied: rows holds the classified column tax_code from the database',
    ]);
    expect(check(`${picked.replace('before', 'rows')}\nconst ids = rows.map((r) => r.id);\nctx.audit({ ids });`)).toEqual([]);
    // Each call is read on its own: a write between two calls counts for the second.
    expect(check('const previous = {};\nconst facts = { previous };\nctx.audit(facts);\nprevious.code = party.tax_code;\nctx.audit(facts);')).toEqual([
      'previous: the value reads the classified column tax_code outside auditValue(...)',
    ]);
    expect(check('const previous = {};\nprevious[party.email] = true;\nctx.audit({ previous });')).toEqual(['previous: the value reads the classified column email outside auditValue(...)']);
    // The declaration in scope is the one in the fact's block, not one in a block that has closed.
    expect(check('const code = party.tax_code;\nif (ok) { const code = 0; use(code); }\nctx.audit({ code });')).toEqual([
      'code: the value reads the classified column tax_code outside auditValue(...)',
    ]);
    expect(check('const code = 0;\nif (ok) { const code = party.tax_code; use(code); }\nctx.audit({ code });')).toEqual([]);
    expect(check('ctx.audit({ id, ...(flag ? { email: x } : {}) });')).toEqual(['email: the key names a classified column and its value is not auditValue(...)']);
    // A classified value under another name, a bracket read, and auditValue naming one column but reading another.
    expect(check('ctx.audit({ code: taxCode });')).toEqual(['code: the value is taxCode, named like a classified column, outside auditValue(...)']);
    expect(check("ctx.audit({ code: row['tax_code'] });")).toEqual(['code: the value reads the classified column tax_code by name outside auditValue(...)']);
    expect(check("ctx.audit({ kind: auditValue(PARTY, 'kind', before.tax_code) });")).toEqual(['kind: auditValue names kind but reads tax_code']);
    // A wrapper: the facts of each call are its own, and one not written out is refused.
    const wrapper = ['function audit(ctx: CommandContext, result: R, facts: Record<string, unknown>) {', '  ctx.audit({ ...facts, done: result.done.length });', '}'].join('\n');
    expect(check(`${wrapper}\naudit(ctx, result, { add: input.add });`)).toEqual([]);
    expect(check(`${wrapper}\naudit(ctx, result, { email: input.email });`)).toEqual(['email: the key names a classified column and its value is not auditValue(...)']);
    expect(check(`${wrapper}\naudit(ctx, result, someFacts);`)).toEqual(['audit(...): audit passes its argument to ctx.audit; write the facts out as an object literal at the call']);
    // A helper that passes a parameter on as a fact's value: each call's argument is read as that value.
    const done = 'const done = (reason: string) => {\n  ctx.audit({ agent: agent.id, reason });\n  return null;\n};';
    expect(check(`${done}\nif (x) return done('not_runnable');`)).toEqual([]);
    expect(check(`${done}\nif (x) return done(party.email);`)).toEqual(['done(...): the value reads the classified column email outside auditValue(...)']);
    // A parameter the helper masks itself does not make it a wrapper; one with no call in its file cannot be read.
    const record = "function record(ctx: C, code: string) {\n  ctx.audit({ previous: auditValue(PARTY, 'tax_code', code) });\n}";
    expect(check(`${record}\nrecord(ctx, party.tax_code);`)).toEqual([]);
    expect(check('export function record(ctx: C, facts: F) {\n  ctx.audit({ ...facts });\n}')).toEqual([
      'record(...): record passes its parameter facts to ctx.audit and has no call in this file to read',
    ]);
  });

  it('allows a listed fact only as listed: the same key with another value is still checked (#1632)', () => {
    const findings = (source: string) => scan('modules/finance/src/accounts.ts', source, classified).map((f) => f.fact);
    expect(findings('ctx.audit({ code, previous: { name: account.name, active: account.active }, name, active });')).toEqual([]);
    expect(findings('ctx.audit({ code, name: party.name });')).toEqual(['name']);
    expect(findings('ctx.audit({ code, owner: account.name });')).toEqual(['owner']);
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
