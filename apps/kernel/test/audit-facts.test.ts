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
//   destructured from a classified property (`const { tax_code: code } = before`), or
// - a fact reads a query's column by the alias a classified column was selected as (`select('tax_code as code')`), or
//   a name holds a call's result computed from a classified column (`formatTaxCode(before.tax_code)`) by a call that
//   neither masks it (auditValue, a hash, a count, a yes or no) nor takes ctx, or
// - facts are written through anything but a call of ctx.audit or a DomainError's `audit:` (`c.audit(...)`, a
//   destructured `audit`, `ctx['audit']`) (#1821).
// What a name is given after its declaration (`facts = { ...facts, email }`, `name += ...`, Object.assign(name, ...),
// `facts.email = ...` on an object written out) is read like its initializer; a `let` with no value written any other
// way is not traced. Casts, parentheses and non-null assertions are seen through. A length or size of a value is a
// count. A value computed before the call (a comparison, arithmetic, a call that takes ctx) holds none of what it read.
// A helper that passes its parameter on to ctx.audit has every call of it in its file read: as the facts (social's
// bulk-edit `audit(ctx, result, facts)`, where a call whose facts are not written out is a finding) or as a fact's value
// (`done(reason)`); a helper with no call in its file is a finding. Any other destructured name is checked by its name
// only, and the db tests (audit-facts.db.test.ts and each command's own) check what the rows hold.
// auditValue (@crove/kernel-contract) replaces a classified value with a marker naming its class. Facts whose key or value
// names a classified column but hold internal data (an account's name, a command's name) are listed below per file,
// each as the exact fact key and value it covers, with its reason; an entry covers nothing else in its file (#1632).
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditValue, columns, type DataClass } from '@crove/kernel-contract';
import {
  BUILT,
  COPY_OF,
  QUERY,
  ROOT,
  SCANNED,
  balanced,
  blank,
  classifiedColumns,
  collapse,
  escape,
  heldPart,
  objectish,
  snake,
  sources,
  splitTop,
  unreadProperties,
  unwrap,
  valueAt,
  variables,
} from './source-scan.ts';

// A call whose result is no classified value though it reads one (#1821): a mask (auditValue, a keyed hash), a count, or
// a yes or no (`Boolean(x)`, `isValidTaxCode(x)`, `hasEmail(x)`).
const MASKS = /(?:^|\.)(?:auditValue|keyedHash|hashText|sha256|count|Boolean|is[A-Z]\w*|has[A-Z]\w*)$/;

// Facts whose key or value names a classified column but holds internal data, per file, with the reason. An entry is
// `<fact key> <- <value>` (whitespace collapsed; the key itself for a shorthand property) and covers that fact only;
// a name with a declaration is listed with its initializer, `<key> <- <name> = <initializer>`, and what is written to
// it after the declaration is still read (#1821).
const ALLOWED: Record<string, Record<string, string>> = {
  'packages/kernel/src/agents.ts': {
    'proposal_command <- info.name': 'the name of the command a proposal runs',
    'title <- before.title': 'the title of a position in the org chart (crove_kernel.position.title, internal)',
  },
  'modules/social/src/review-links.ts': {
    'cleared <- body === null': 'whether the reply was cleared, a boolean',
    'member <- userId = data.data.userId': "the removed member's user id, from the event's parsed payload (zod's .data)",
  },
  'packages/kernel/src/proposal-reminders.ts': {
    'policy <- input': "the command's whole input, the policy's three day counts",
    'recipients <- Object.fromEntries([...recipients].map(([s, ids]) => [s, ids.length]))': 'how many members each stage reminded, a count per stage',
  },
  'packages/kernel/src/org-address.ts': { 'cleared <- email === null': 'whether the contact address was cleared, a boolean' },
  'modules/crm/src/booking-feed.ts': { 'member <- userId = data.data.userId': "the removed member's user id, from the event's parsed payload (zod's .data)" },
  'modules/finance/src/accounts.ts': {
    'name <- account.name': "the previous name of an account of the org's chart (crove_finance.account.name, internal)",
    'name <- name = input.name ?? account.name': "the new name of an account of the org's chart (crove_finance.account.name, internal)",
  },
  'modules/finance/src/bank.ts': { 'bankAccount <- input.bankAccount': 'the chart account code (112x) the statement is for, not a bank account number' },
  'modules/finance/src/missing-invoices.ts': { 'skipped <- skipped': 'the periods too large to reconcile' },
  'modules/finance/src/portal-list.ts': { 'skipped <- input.skippedCount': "the count of the portal list's skipped rows, not the rows" },
  'modules/social/src/archive.ts': { 'skipped <- result.skipped.map((s) => ({ post_id: s.postId, reason: s.reason }))': 'the post ids left out and why' },
  'modules/social/src/bulk-edit.ts': { 'skipped <- result.skipped.map((s) => ({ post_id: s.postId, reason: s.reason }))': 'the post ids left out and why' },
  'modules/social/src/digest.ts': { 'skipped <- skipped = 0': 'the count of digest mails that failed' },
  'modules/social/src/report-branding.ts': { 'name <- name = input.name ? input.name : null': "the org's own brand name on its reports (crove_social.report_branding.display_name, internal)" },
  'modules/social/src/report-schedules.ts': { 'recipients <- recipients.length': 'the count of recipients, never their addresses' },
};

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
  // A declaration with no initializer (`let facts;`) holds nothing until it is assigned.
  const declaration = (name: string, at: number) => {
    const decl = [...code.slice(0, at).matchAll(new RegExp(`\\b(?:const|let|var)\\s+${escape(name)}\\s*(?::[^=;]+)?(?:=(?![=>])\\s*|(?=;))`, 'g'))]
      .filter((d) => inScope(d.index ?? 0, at))
      .at(-1);
    if (!decl) return undefined;
    const from = (decl.index ?? 0) + decl[0].length;
    return { index: decl.index ?? 0, from, init: decl[0].includes('=') ? valueAt(code, from).trim() : '' };
  };
  const isRow = (name: string, at: number) => {
    const decl = declaration(name, at);
    return decl !== undefined && QUERY.test(decl.init);
  };

  // One fact: its key, then its value. A listed `<key> <- <value>` passes.
  // A listed name with a declaration is listed with its initializer (`name <- name = input.name ?? account.name`), and
  // what is written to it later is still read (#1821).
  const checkFact = (key: string, value: string, at: number, depth = 0) => {
    const trimmed = value.trim();
    const flag = reporter(at, key);
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      const decl = enclosingAll(at).some((f) => f.params.includes(trimmed)) ? undefined : declaration(trimmed, at);
      if (decl && Object.hasOwn(allowed, `${key} <- ${trimmed} = ${collapse(decl.init)}`)) {
        checkName(trimmed, at, flag, depth + 1, true, true);
        return;
      }
      if (!decl && Object.hasOwn(allowed, `${key} <- ${trimmed}`)) return;
    } else if (Object.hasOwn(allowed, `${key} <- ${collapse(trimmed)}`)) return;
    if (isClassified(key) && !/^auditValue\s*\(/.test(trimmed)) {
      flag('the key names a classified column and its value is not auditValue(...)');
      return;
    }
    // An object written out has each of its keys read as a fact of its own.
    if (trimmed.startsWith('{') && balanced(trimmed, 0) === trimmed) {
      for (const p of unreadProperties(trimmed)) flag(`the scan cannot read the property ${collapse(p)}; write it as key: value`);
      return;
    }
    checkValue(trimmed, at, flag, depth);
  };

  // A value: what it reads, the variables it names, the auditValue calls in it, and what a name of the file holds.
  const checkValue = (value: string, at: number, flag: (problem: string) => void, depth: number) => {
    const start = code.indexOf(value, Math.max(0, at - 1));
    const bare = withoutAuditValue(value);
    // A read's length or size is a count, not the value (`party.name.length`).
    for (const read of bare.matchAll(/\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()(?!\s*(?:\?\.|\.)\s*(?:length|size)\b)/g)) {
      if (isClassified(read[1] as string)) flag(`the value reads the classified column ${read[1]} outside auditValue(...)`);
    }
    // A read of a query's result by the alias a classified column was selected as (`select('tax_code as code')`).
    for (const read of bare.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*!?\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\b(?!\s*\()(?!\s*(?:\?\.|\.)\s*(?:length|size)\b)/g)) {
      const decl = declaration(read[1] as string, at);
      if (!decl || !QUERY.test(decl.init)) continue;
      for (const [column, alias] of selected(decl.init, decl.from)) {
        if (alias === read[2] && alias !== column && isClassified(column)) flag(`the value reads the classified column ${column} as ${alias} outside auditValue(...)`);
      }
    }
    // A read by the column's name: `row['tax_code']`.
    // An array written out (`['title']`) is no read.
    for (const read of bare.matchAll(/[\w$)\]]\s*\[\s*['"]/g)) {
      const column = start === -1 ? undefined : literalAt(start + (read.index ?? 0) + read[0].indexOf('[') + 1);
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
  // the part of its initializer it holds, and a call's result by its arguments unless it masks or takes ctx (#1821).
  // Every later assignment (`facts = { ...facts, email }`) and Object.assign(name, ...) up to the call is read the
  // same way. A parameter that is the whole value is checked at the calls of its function when that function is a
  // wrapper, and is a finding otherwise (a command's `input` handed over whole). A destructured name is a finding when
  // it renames a classified property, and is otherwise checked by its name only. With `listed`, the fact is an
  // allowlist entry naming this declaration (`name <- name = <initializer>`): its initializer is taken as listed, and
  // only what is written to the name after it is read. Returns whether the name was traced.
  const checkName = (name: string, at: number, flag: (problem: string) => void, depth: number, whole = true, listed = false): boolean => {
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
    // A container is read up to the fact's own call (`useAt`), even when reached through another declaration.
    const end = Math.max(at, useAt);
    const key = `${decl.index}:${end}`;
    if (traced.has(key)) return true;
    traced.add(key);
    const scope = code.slice(from, end);
    // A write to another variable of the same name (declared, or a parameter, in a nested function or block) is not a
    // write to this one.
    const ours = (offset: number) =>
      declaration(name, from + offset)?.index === decl.index &&
      !enclosingAll(from + offset).some((f) => f.params.includes(name) && !(f.start <= decl.index && decl.index < f.end));
    // Plain and compound assignments (`name = ...`, `name += ...`, `name ??= ...`).
    const assigned = [
      ...scope.matchAll(new RegExp(`(?<![\\w$.])(?<!\\b(?:const|let|var)\\s+)${escape(name)}\\s*(?:\\*\\*|\\?\\?|\\|\\||&&|[-+*/%&|^])?=(?![=>])\\s*`, 'g')),
    ].filter((w) => ours(w.index ?? 0));
    // A write the scan cannot follow (a destructuring assignment, `({ raw: facts } = input)`, or a for...of) is a finding,
    // and the rest of what the name holds is still read; a let with no value that is never assigned is untraced.
    if (unfollowedWrite(name, scope, from, ours)) {
      flag(`${name} is written by a destructuring assignment or a for...of the scan cannot follow; assign it plainly`);
    } else if (init === '' && assigned.length === 0) return false;
    const isBuilt = (value: string) => BUILT.test(value) || /^new\s+(?:Map|Set)\s*</.test(value);
    // The initializer is read whatever is assigned later (`let facts = { code }; if (redact) facts = {};`).
    if (!isBuilt(init) && !listed) checkHeld(name, init, from, flag, depth);
    // Writes to its properties add to what the name holds, here or in a function of this file it is handed to
    // (`fill(facts)`, whose parameter is the same object).
    readWrites(name, from, end, ours, flag, depth);
    for (const call of scope.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const fn = functions.find((f) => f.name === call[1]);
      // A call, not the function's own definition (`function fill(facts) {`).
      if (!fn || !ours(call.index ?? 0) || /\bfunction\s*$/.test(code.slice(0, from + (call.index ?? 0)))) continue;
      const open = from + (call.index ?? 0) + call[0].length - 1;
      splitTop(balanced(code, open).slice(1, -1)).forEach((arg, i) => {
        const param = fn.params[i];
        if (arg.trim() === name && param !== undefined && /^[A-Za-z_$][\w$]*$/.test(param)) readWrites(param, fn.start, fn.end, () => true, flag, depth);
      });
    }
    // A later assignment replaces what the name holds; Object.assign(name, ...) adds to it.
    for (const w of assigned) {
      const rhsFrom = from + (w.index ?? 0) + w[0].length;
      checkHeld(name, valueAt(code, rhsFrom).trim(), rhsFrom, flag, depth);
    }
    for (const w of scope.matchAll(new RegExp(`\\bObject\\s*\\.\\s*assign\\s*\\(\\s*${escape(name)}\\b\\s*,`, 'g'))) {
      if (!ours(w.index ?? 0)) continue;
      const open = from + (w.index ?? 0) + w[0].indexOf('(');
      for (const arg of splitTop(balanced(code, open).slice(1, -1)).slice(1)) {
        if (objectish(arg.trim())) checkObject(arg.trim(), code.indexOf(arg.trim(), open), depth);
        else checkValue(arg.trim(), open, flag, depth);
      }
    }
    return true;
  };

  // The writes to `name`'s properties between `start` and `stop` (`name.email = ...`, `name[k] = ...`, push, set, add):
  // each key that names a classified column needs auditValue, and each value is read.
  const readWrites = (name: string, start: number, stop: number, own: (offset: number) => boolean, flag: (problem: string) => void, depth: number) => {
    const scope = code.slice(start, stop);
    for (const w of scope.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}\\s*(\\[[^\\]]*\\]|\\.\\s*[A-Za-z_$][\\w$]*)\\s*=(?![=>])\\s*`, 'g'))) {
      if (!own(w.index ?? 0)) continue;
      const target = w[1] as string;
      const key = target.startsWith('[') ? literalAt(start + (w.index ?? 0) + w[0].indexOf('[') + 1) : target.replace(/^\.\s*/, '');
      const rhs = valueAt(code, start + (w.index ?? 0) + w[0].length).trim();
      if (key && isClassified(key) && !/^auditValue\s*\(/.test(rhs)) flag(`${name}.${key} is a classified column and its value is not auditValue(...)`);
      // A computed key is stored too: `previous[party.email] = true` carries the address.
      if (target.startsWith('[') && key === undefined) checkValue(target.slice(1, -1).trim(), start + (w.index ?? 0) + w[0].indexOf('[') + 1, flag, depth);
      if (objectish(rhs)) checkObject(rhs, start + (w.index ?? 0) + w[0].length, depth);
      else checkValue(rhs, start + (w.index ?? 0) + w[0].length, flag, depth);
    }
    for (const w of scope.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}\\s*\\.\\s*(push|set|add|unshift)\\s*\\(`, 'g'))) {
      if (!own(w.index ?? 0)) continue;
      const open = start + (w.index ?? 0) + w[0].length - 1;
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
  };

  // Whether `name` is written in `scope` (starting at `from`) by a for...of or a destructuring assignment
  // (`[facts] = rows`, `({ raw: facts } = input)`): a pattern around it, not declared, followed by `=`.
  const unfollowedWrite = (name: string, scope: string, from: number, own: (offset: number) => boolean) => {
    for (const m of scope.matchAll(new RegExp(`\\bfor\\s*\\(\\s*${escape(name)}\\s+(?:of|in)\\b`, 'g'))) {
      if (own(m.index ?? 0)) return true;
    }
    for (const m of scope.matchAll(new RegExp(`[{[,:]\\s*${escape(name)}\\s*(?=[,}\\]=])`, 'g'))) {
      if (!own(m.index ?? 0)) continue;
      let pos = from + (m.index ?? 0) + m[0].length;
      for (let level = 0; level < 3; level++) {
        let depth = 0;
        let opener = -1;
        for (let i = pos - 1; i >= 0; i--) {
          const c = code[i] as string;
          if (')]}'.includes(c)) depth++;
          else if ('([{'.includes(c) && depth-- === 0) {
            opener = i;
            break;
          }
        }
        // A bracket after a name is a member access (`previous[field] = ...`), not a pattern.
        if (opener === -1 || code[opener] === '(' || (code[opener] === '[' && /[\w$)\]]\s*$/.test(code.slice(0, opener)))) break;
        const after = code.slice(opener + balanced(code, opener).length);
        if (/^\s*=(?![=>])/.test(after)) {
          if (!/\b(?:const|let|var)\s*$/.test(code.slice(0, opener))) return true;
          break;
        }
        if (!/^\s*[,}\]]/.test(after)) break;
        pos = opener;
      }
    }
    return false;
  };

  // What an initializer or an assignment's right side gives a name: a query's columns, an object's facts, an array's
  // elements, the part of a value it holds, or the arguments of a call that computes from them.
  const checkHeld = (name: string, init: string, from: number, flag: (problem: string) => void, depth: number) => {
    if (QUERY.test(init)) {
      if (/\b(?:selectAll|returningAll)\s*\(/.test(init) || /^(?:await\s+)?sql\b/.test(init)) {
        flag(`${name} is a whole row from the database; pass the columns it needs, classified ones through auditValue(...)`);
        return;
      }
      for (const [column] of selected(init, from)) {
        if (isClassified(column)) flag(`${name} holds the classified column ${column} from the database`);
      }
      return;
    }
    if (objectish(init)) {
      checkObject(init, from, depth);
      return;
    }
    // An array written out holds its elements: each, or each spread (`...(a !== b ? ['title'] : [])`), by what it holds.
    if (init.startsWith('[') && balanced(init, 0) === init) {
      for (const element of splitTop(init.slice(1, -1))) {
        const item = unwrap(element.trim().replace(/^\.\.\.\s*/, ''));
        const held = item === '' ? null : heldPart(item);
        if (held !== null) checkValue(held.trim(), from + init.indexOf(held.trim()), flag, depth);
      }
      return;
    }
    const held = heldPart(init);
    if (held !== null) {
      checkValue(held.trim(), from + init.indexOf(held.trim()), flag, depth);
      return;
    }
    // A call computes a new value, but one made from a classified value may still be it (`formatTaxCode(tax_code)`):
    // its arguments are read unless the call masks them or takes ctx (a command or query helper returning an id).
    const call = /^([A-Za-z_$][\w$.]*)\s*(?:<[^>]*>)?\s*\(/.exec(unwrap(init.replace(/^await\s+/, '')));
    if (!call || MASKS.test(call[1] as string)) return;
    const expr = unwrap(init.replace(/^await\s+/, ''));
    const list = balanced(expr, call[0].length - 1);
    if (list.length + call[0].length - 1 !== expr.length) return;
    const args = splitTop(list.slice(1, -1)).map((a) => a.trim());
    if (args.includes('ctx')) return;
    // Only an argument that reads a classified column itself counts: a row or a payload handed over is the callee's.
    for (const arg of args) {
      for (const read of withoutAuditValue(arg).matchAll(/\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()(?!\s*(?:\?\.|\.)\s*(?:length|size)\b)/g)) {
        if (isClassified(read[1] as string)) flag(`${name} is computed by ${call[1]}(...) from the classified column ${read[1]}; mask it with auditValue(...)`);
      }
    }
  };

  // The columns a query selects or returns, each with the name it is read by (`p.tax_code as code` is read as `code`).
  const selected = (init: string, from: number): Array<[column: string, alias: string]> => {
    const out: Array<[string, string]> = [];
    for (const pick of init.matchAll(/\.\s*(?:select|returning)\s*\(/g)) {
      const open = (pick.index ?? 0) + pick[0].length - 1;
      const list = balanced(init, open);
      for (const q of list.matchAll(/['"]/g)) {
        if ((q.index ?? 0) > 0 && /['"]/.test(list[(q.index ?? 0) - 1] as string)) continue;
        const lit = literalAt(from + open + (q.index ?? 0));
        if (!lit) continue;
        const [source, alias] = lit.split(/\s+as\s+/i);
        const column = source?.trim().split('.').at(-1) ?? '';
        out.push([column, (alias ?? column).trim()]);
      }
    }
    return out;
  };

  // Every key and value of a fact object's text, nested objects included, and its spreads.
  const checkObject = (obj: string, start: number, depth = 0) => {
    const whole = unwrap(obj);
    if (whole.startsWith('{') && balanced(whole, 0) === whole) {
      for (const p of unreadProperties(whole)) reporter(start, p)('the scan cannot read this property; write it as key: value');
    }
    // Shorthand properties: `{ taxCode }` carries the variable's value under a column's name.
    for (const m of obj.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) checkFact(m[1] as string, m[1] as string, start + (m.index ?? 0), depth);
    // Named, numeric and quoted keys; a quoted key's text is blanked in `code`, so it is read from `text`.
    for (const m of obj.matchAll(/[{,]\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*:/g)) {
      const raw = m[1] as string;
      const key = /^['"]/.test(raw) ? (literalAt(start + (m.index ?? 0) + m[0].indexOf(raw)) ?? '') : raw;
      checkFact(key, valueAt(obj, (m.index ?? 0) + m[0].length), start + (m.index ?? 0) + m[0].length, depth);
    }
    // A getter or a method (toJSON) runs when the facts are serialized, so what it returns cannot be read here.
    for (const m of obj.matchAll(/[{,]\s*(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*|\[[^\]]*\])\s*\([^()]*\)\s*(?::[^{};]*)?\{/g)) {
      reporter(start + (m.index ?? 0), m[1] as string)('a getter or method computes the fact when it is written; write the value out');
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
    const bodies: Array<{ text: string; at: number }> = [];
    let fnParams: string[] = [];
    const fn = functions.find((f) => f.name === name);
    if (fn) {
      spreadRead.add(fn);
      fnParams = fn.params;
      for (const r of code.slice(fn.start, fn.end).matchAll(/\breturn\s+/g)) {
        const from = fn.start + (r.index ?? 0) + r[0].length;
        bodies.push({ text: valueAt(code, from).trim(), at: from });
      }
    } else {
      const decl = new RegExp(`\\bconst\\s+${escape(name)}\\s*(?::[^=]*)?=\\s*(?:async\\s*)?`).exec(code);
      const arrow = decl ? code.indexOf('=>', decl.index) : -1;
      if (decl && arrow !== -1) {
        const head = decl.index + decl[0].length;
        if (code[head] === '(') fnParams = params(balanced(code, head));
        const from = arrow + 2 + (/^\s*/.exec(code.slice(arrow + 2))?.[0].length ?? 0);
        bodies.push({ text: valueAt(code, from).trim(), at: from });
      }
    }
    if (bodies.length === 0 || depth >= 4) {
      flag(`the facts spread ${name}(...), whose result the scan cannot read; write them out`);
      return;
    }
    // An argument is read as a value only when its parameter reaches a return whole, outside auditValue: a parameter
    // masked there, or read for a column (`p.id`, read in the body), does not carry the argument.
    const returned = new Set(bodies.flatMap((b) => variables(withoutAuditValue(b.text))));
    splitTop(balanced(spread, open).slice(1, -1)).forEach((arg, i) => {
      const param = fnParams[i];
      if (param === undefined || !/^[A-Za-z_$][\w$]*$/.test(param) || returned.has(param)) checkValue(arg.trim(), at, flag, depth);
    });
    for (const body of bodies) {
      if (objectish(body.text)) checkObject(body.text, body.at, depth + 1);
      else checkFact(`...${name}(...)`, body.text, body.at, depth + 1);
    }
  };

  // The audit facts of this file: ctx.audit(...)'s argument (ctx?.audit too), every `audit: { ... }`, every `audit:` that
  // names a variable (`{ audit: facts }`, a DomainError's or an options object's), and any other `audit:` value inside a
  // DomainError's arguments (#1821). An `audit:` holding a type, a route or a function (the runtime's own) is none.
  const sites: Array<{ at: number; arg: string }> = [];
  for (const m of code.matchAll(/\bctx\s*(?:\?\.|\.)\s*audit\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    sites.push({ at: open, arg: balanced(code, open) });
  }
  const errorArgs = [...code.matchAll(/\bnew\s+DomainError\s*\(/g)].map((e) => {
    const open = (e.index ?? 0) + e[0].length - 1;
    return { start: open, end: open + balanced(code, open).length };
  });
  // The object around a property is a type when a type alias, an interface, a generic or an annotation opens it.
  // The innermost bracket open at `pos` (`pos` itself when it opens one).
  const openerOf = (pos: number) => {
    let depth = 0;
    for (let i = pos; i >= 0; i--) {
      const c = code[i] as string;
      if (')]}'.includes(c)) depth++;
      else if ('([{'.includes(c) && depth-- === 0) return i;
    }
    return -1;
  };
  const inType = (at: number) => {
    const opener = openerOf(at);
    if (opener === -1 || code[opener] !== '{') return false;
    const before = code.slice(Math.max(0, opener - 300), opener);
    if (/(?:\btype\s+[\w$]+(?:<[^>]*>)?\s*=|\binterface\s+[\w$]+(?:<[^>]*>)?(?:\s+extends\s+[^{]+)?|[<|&]|\b(?:const|let|var)\s+[\w$]+\s*:)\s*$/.test(before)) return true;
    // A parameter's annotation: `name:` (or `name?:`) inside a parameter list, not a property inside an object.
    return /[(,]\s*[\w$]+\??\s*:\s*$/.test(before) && code[openerOf(opener - 1)] === '(';
  };
  for (const m of code.matchAll(/[{,]\s*audit\s*:\s*/g)) {
    const at = (m.index ?? 0) + m[0].length;
    if (inType(m.index ?? 0)) continue;
    const value = valueAt(code, at).trim();
    const inError = errorArgs.some((e) => e.start < at && at < e.end);
    if (code[at] === '{') sites.push({ at, arg: `(${balanced(code, at)})` });
    else if (/^[A-Za-z_$][\w$]*$/.test(value) && !/^(?:boolean|string|number|bigint|unknown|any|never|object)$/.test(value)) sites.push({ at, arg: `(${value})` });
    else if (inError) sites.push({ at, arg: `(${value})` });
  }
  // The audit log is written through a call of ctx.audit only. Another receiver (`c.audit(...)`), ctx.audit reached
  // without a call (`ctx['audit']`, `ctx.audit.call(...)`, `const w = ctx.audit`) or a bare `audit(...)` that is no
  // function of this file (a destructured `audit`) writes facts this scan never reads (#1821).
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*audit\s*\(/g)) {
    if (m[1] !== 'ctx') reporter(m.index ?? 0, `${m[1]}.audit(...)`)('audit facts are written through ctx.audit(...), which the scan reads; call that');
  }
  for (const m of code.matchAll(/\bctx\s*(?:(?:\?\.|\.)\s*audit\b(?!\s*\()|\[)/g)) {
    // A bracket read of another member (`ctx['trx']`) is no audit; one of audit or of a computed key may be.
    const key = m[0].endsWith('[') ? literalAt((m.index ?? 0) + m[0].length) : undefined;
    if (key !== undefined && key !== 'audit') continue;
    reporter(m.index ?? 0, 'ctx.audit')('ctx.audit is reached without a call the scan reads; call ctx.audit(...)');
  }
  for (const m of code.matchAll(/(?<![\w$.])audit\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    // A function of this file named audit (a helper read below), its definition, or a method signature.
    if (/\bfunction\s+$/.test(code.slice(0, m.index)) || /^\s*(?::|\{)/.test(code.slice(open + balanced(code, open).length))) continue;
    if (functions.some((f) => f.name === 'audit')) continue;
    reporter(m.index ?? 0, 'audit(...)')('a bare audit(...) writes facts the scan does not read; call ctx.audit(...)');
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
        const [key, listed] = entry.split(' <- ') as [string, string];
        // A name listed with its initializer: the declaration is still written so.
        const declared = /^([A-Za-z_$][\w$]*) = (.*)$/.exec(listed);
        const value = declared ? (declared[1] as string) : listed;
        if (declared) expect(new RegExp(`\\b${value}\\s*(?::[^=;]+)?= ${escape(declared[2] as string)}`).test(code), `${file}: ${entry}`).toBe(true);
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
    expect(check('ctx.audit({ previous: { code: null }.code ?? party.tax_code });')).toEqual(['previous: the value reads the classified column tax_code outside auditValue(...)']);
    // A parenthesized comparison holds a boolean; a helper that masks or projects its argument does not carry it.
    expect(check('const changed = (before.tax_code !== input.taxCode);\nctx.audit({ changed });')).toEqual([]);
    expect(check("const maskedFact = (code: string) => ({ code: auditValue(PARTY, 'tax_code', code) });\nctx.audit({ ...maskedFact(party.tax_code) });")).toEqual([]);
    expect(check('function idOf(p: P) { return { id: p.id }; }\nctx.audit({ ...idOf(party) });')).toEqual([]);
    expect(check('ctx.audit({ previous: { get code() { return party.tax_code; } } });')).toEqual([
      'code: a getter or method computes the fact when it is written; write the value out',
    ]);
    // Numeric and quoted keys are read; a property of no form the scan knows is refused.
    expect(check('ctx.audit({ previous: { 0: party.tax_code } });')).toEqual(['0: the value reads the classified column tax_code outside auditValue(...)']);
    expect(check("ctx.audit({ previous: { 'tax_code': x } });")).toEqual(['tax_code: the key names a classified column and its value is not auditValue(...)']);
    expect(check('ctx.audit({ previous: { 0x1: party.tax_code } });')).toEqual([
      'previous: the scan cannot read the property 0x1: party.tax_code; write it as key: value',
    ]);
    expect(check('ctx.audit({ previous: { toJSON() { return party.tax_code; } } });')).toEqual([
      'toJSON: a getter or method computes the fact when it is written; write the value out',
    ]);
    expect(check('ctx.audit({ previous: { get [key]() { return party.tax_code; } } });')).toEqual([
      '[key]: a getter or method computes the fact when it is written; write the value out',
    ]);
    // An array of the names that changed holds the names, not the values its conditions compare.
    expect(check("const changed = [...(before.title !== input.title ? ['title'] : []), ...(before.tax_code !== code ? ['tax_code'] : [])];\nctx.audit({ changed });")).toEqual([]);
    expect(check('const changed = [...(flag ? [before.tax_code] : [])];\nctx.audit({ changed });')).toEqual(['changed: the value reads the classified column tax_code outside auditValue(...)']);
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

  it('fails on aliases, reassignments, computed calls and other audit calls (#1821)', () => {
    const check = (source: string) => scan('fixture.ts', source, classified).map((f) => `${f.fact}: ${f.problem}`);
    const untracedFacts = 'facts: the facts are a name the scan cannot trace; write them out';
    const unfollowed = 'facts: facts is written by a destructuring assignment or a for...of the scan cannot follow; assign it plainly';
    // A query's column read by the alias it was selected as.
    const aliased = "const before = await ctx.trx.selectFrom('crove_kernel.party').select(['id', 'tax_code as code']).executeTakeFirstOrThrow();";
    expect(check(`${aliased}\nctx.audit({ previous: before.code });`)).toEqual(['previous: the value reads the classified column tax_code as code outside auditValue(...)']);
    expect(check(`${aliased}\nctx.audit({ partyId: before.id });`)).toEqual([]);
    // What a name is given after its declaration: an assignment, a merge, Object.assign, a declaration with no value.
    expect(check('let facts = { id };\nfacts = { ...facts, email: p.email };\nctx.audit(facts);')).toEqual([
      'email: the key names a classified column and its value is not auditValue(...)',
    ]);
    expect(check('let previous = {};\nprevious = { code: p.tax_code };\nctx.audit({ previous });')).toEqual([
      'code: the value reads the classified column tax_code outside auditValue(...)',
    ]);
    expect(check('const previous = {};\nObject.assign(previous, { code: p.tax_code });\nctx.audit({ previous });')).toEqual([
      'code: the value reads the classified column tax_code outside auditValue(...)',
    ]);
    expect(check('let facts;\nfacts = { email: input.email };\nctx.audit(facts);')).toEqual(['email: the key names a classified column and its value is not auditValue(...)']);
    expect(check('let facts = { id };\nfacts = { id, done: true };\nctx.audit(facts);')).toEqual([]);
    expect(check('let facts: Record<string, unknown>;\nfacts = {};\nfacts.email = input.email;\nctx.audit(facts);')).toEqual([
      'facts: facts.email is a classified column and its value is not auditValue(...)',
      'facts: the value reads the classified column email outside auditValue(...)',
    ]);
    expect(check('let facts = { code: party.tax_code };\nif (redact) facts = {};\nctx.audit(facts);')).toEqual([
      'code: the value reads the classified column tax_code outside auditValue(...)',
    ]);
    // Writes after a non-empty assignment, a renamed destructuring target, and writes through a helper the object is given.
    expect(check('let facts: Record<string, unknown>;\nfacts = { id: 1 };\nfacts.email = input.email;\nctx.audit(facts);')).toEqual([
      'facts: facts.email is a classified column and its value is not auditValue(...)',
      'facts: the value reads the classified column email outside auditValue(...)',
    ]);
    expect(check('let facts: Record<string, unknown>;\nfacts = {};\n({ raw: facts } = input);\nctx.audit(facts);')).toEqual([unfollowed]);
    expect(check('function fill(facts: Record<string, unknown>) { facts.email = input.email; }\nconst facts = {};\nfill(facts);\nctx.audit(facts);')).toEqual([
      'facts: facts.email is a classified column and its value is not auditValue(...)',
      'facts: the value reads the classified column email outside auditValue(...)',
    ]);
    // An assignment to a parameter of the same name in a nested function is not one to the fact's variable.
    expect(check('const code = 0;\nfunction normalize(code: string) { code = party.tax_code; return code; }\nctx.audit({ code });')).toEqual([]);
    // A call that computes from a classified column carries it; one that masks it, counts it or takes ctx does not.
    expect(check('const code = formatTaxCode(before.tax_code);\nctx.audit({ code });')).toEqual([
      'code: code is computed by formatTaxCode(...) from the classified column tax_code; mask it with auditValue(...)',
    ]);
    expect(check('const code = keyedHash(before.tax_code);\nctx.audit({ code });')).toEqual([]);
    expect(check('const known = Boolean(party.email);\nctx.audit({ known });')).toEqual([]);
    expect(check('const where = countryOf(party.address);\nctx.audit({ where });')).toEqual([
      'where: where is computed by countryOf(...) from the classified column address; mask it with auditValue(...)',
    ]);
    // A write to an object written out adds to it.
    expect(check('const facts = { id: 1 };\nfacts.email = p.email;\nctx.audit(facts);')).toEqual([
      'facts: facts.email is a classified column and its value is not auditValue(...)',
      'facts: the value reads the classified column email outside auditValue(...)',
    ]);
    expect(check('const partyId = await partyFor(ctx, booking.email);\nctx.audit({ partyId });')).toEqual([]);
    expect(check('const source = resubmitSource(old);\nctx.audit({ source });')).toEqual([]);
    // A length or size is a count.
    expect(check('ctx.audit({ count: party.name.length, tagCount: before.tags?.size });')).toEqual([]);
    // Audit facts reach the log through ctx.audit or a DomainError only, and a DomainError's facts by name are traced.
    expect(check('c.audit({ email });')).toEqual(['c.audit(...): audit facts are written through ctx.audit(...), which the scan reads; call that']);
    const bare = 'audit(...): a bare audit(...) writes facts the scan does not read; call ctx.audit(...)';
    expect(check('const { audit } = ctx;\naudit({ email });')).toEqual([bare]);
    expect(check('const { trx: { x }, audit } = ctx;\naudit({ email });')).toEqual([bare]);
    expect(check('defineCommand({ handler: async ({ audit }, input) => {\n  audit({ email: input.email });\n} });')).toEqual([bare]);
    expect(check('ctx?.audit({ email: p.email });')).toEqual(['email: the key names a classified column and its value is not auditValue(...)']);
    expect(check("const trx = ctx['trx'];\nctx.audit({ id });")).toEqual([]);
    expect(check(`${aliased}\nctx.audit({ count: before.code.length });`)).toEqual([]);
    for (const reach of ["ctx['audit']({ id });", 'ctx[key]({ id });', 'ctx.audit.call(ctx, { id });', 'const w = ctx.audit;\nw({ id });']) {
      expect(check(reach), reach).toEqual(['ctx.audit: ctx.audit is reached without a call the scan reads; call ctx.audit(...)']);
    }
    // Facts under `audit:` anywhere, by name too; a type is none.
    expect(check("const options = { audit: facts };\nthrow new DomainError('X', 409, 'x', undefined, options);")).toEqual([
      'facts: the facts are a name the scan cannot trace; write them out',
    ]);
    expect(check('const { rows } = await sql<{ audit: boolean }>`select 1`.execute(ctx.trx);')).toEqual([]);
    for (const type of ['type LogOptions = { audit: AuditFacts };', 'interface LogOptions { audit: AuditFacts }', 'function log(ctx: C, options: { audit: AuditFacts }) {}']) {
      expect(check(type), type).toEqual([]);
    }
    expect(check('const options = { retry: 1, nested: { audit: facts } };')).toEqual([untracedFacts]);
    // A function's own definition is no call, and a same-named parameter's loop is no write to the fact's variable.
    expect(check('const facts = { id: 1 };\nfunction fill(facts: F) { facts.code = party.tax_code; }\nctx.audit(facts);')).toEqual([]);
    expect(check('const facts = {};\nfunction other(facts: F[]) { for (facts of list) {} }\nctx.audit(facts);')).toEqual([]);
    // A let with no value is traced only through plain assignments; any other write is a finding, never assigned untraced.
    for (const write of ['({ facts } = await load(ctx));', '[facts] = rows;', 'for (facts of list) {}']) {
      expect(check(`let facts;\n${write}\nctx.audit(facts);`), write).toEqual([unfollowed]);
    }
    expect(check('let facts;\nctx.audit(facts);')).toEqual([untracedFacts]);
    // An unfollowed write does not hide what the initializer holds.
    expect(check('let previous = { code: p.tax_code };\nif (replace) ({ previous } = input);\nctx.audit({ previous });')).toEqual([
      'previous: previous is written by a destructuring assignment or a for...of the scan cannot follow; assign it plainly',
      'code: the value reads the classified column tax_code outside auditValue(...)',
    ]);
    expect(check("const facts = { email: input.email };\nthrow new DomainError('X', 409, 'x', undefined, { audit: facts });")).toEqual([
      'email: the key names a classified column and its value is not auditValue(...)',
    ]);
  });

  it('allows a listed fact only as listed: the same key with another value is still checked (#1632)', () => {
    const findings = (source: string) => scan('modules/finance/src/accounts.ts', source, classified).map((f) => f.fact);
    const declared = 'const name = input.name ?? account.name;\n';
    expect(findings(`${declared}ctx.audit({ code, previous: { name: account.name, active: account.active }, name, active });`)).toEqual([]);
    // A listed name is listed with its initializer: another initializer, or a later write to it, is still read (#1821).
    expect(findings('const name = party.name;\nctx.audit({ code, name });')).toEqual(['name']);
    expect(findings('let name = input.name ?? account.name;\nname = party.name;\nctx.audit({ code, name });')).toEqual(['name']);
    expect(findings('let name = input.name ?? account.name;\nname += party.name;\nctx.audit({ code, name });')).toEqual(['name']);
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
