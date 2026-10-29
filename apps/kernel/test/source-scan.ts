// What the source scans for classified values share (#1626 audit facts, #1634 activity summaries): the classified columns
// of every manifest, the sources to read, and a text form of a source in which comments and string text cannot pose as
// code.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataClass, ModuleManifest } from '@crove/kernel-contract';
import { kernelManifest } from '@crove/kernel';
import { crmManifest } from '@crove/mod-crm';
import { financeManifest } from '@crove/mod-finance';
import { notesManifest } from '@crove/mod-notes';
import { socialManifest } from '@crove/mod-social';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SCANNED = ['packages', 'modules', 'apps/kernel/src'];

// The control plane's classified columns (apps/kernel/test/manifest.db.test.ts declares their tables; no source may name
// those tables, but a value could still carry one of their values).
const CONTROL_PLANE_CLASSIFIED = ['subject', 'email', 'display_name', 'token', 'recipient'];

// Every column some manifest classifies (anything but internal: pii, contact, payment, national_id,
// national_id_if_individual, sensitive).
export function classifiedColumns(): Set<string> {
  const out = new Set<string>(CONTROL_PLANE_CLASSIFIED);
  for (const manifest of [kernelManifest, financeManifest, crmManifest, notesManifest, socialManifest] as ModuleManifest[]) {
    for (const tables of Object.values(manifest.tables)) {
      for (const cols of Object.values(tables)) {
        for (const [column, cls] of Object.entries(cols) as Array<[string, DataClass]>) if (cls !== 'internal') out.add(column);
      }
    }
  }
  return out;
}

export const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// The TypeScript sources under dir, tests, generated files and declarations left out.
export function sources(dir: string, out: string[] = []): string[] {
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
export function blank(text: string): string {
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
export function balanced(text: string, open: number): string {
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

// Expressions in blanked code (#1632): what a value holds, how far it reaches, and the names it uses.

// The expression from `start`: up to the next comma, semicolon or closing bracket at its own depth (a semicolon ends a
// statement, so an initializer or an assignment's right side stops there too).
export function valueAt(text: string, start: number): string {
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

export const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

// A query whose result a name holds: what it selects or returns is what a fact that holds it carries.
export const QUERY = /\b(?:selectFrom|updateTable|insertInto|deleteFrom)\s*\(|^(?:await\s+)?sql\b/;
// An empty object, array, Map or Set, filled by the writes that follow it.
export const BUILT = /^(?:\{\s*\}|\[\s*\]|new\s+(?:Map|Set)\s*(?:<[^>]*>)?\s*\(\s*\))(?:\s+as\s+[^]*)?$/;
// A call whose result carries the values it reads (a copy, a projection, a string of them); any other call, a comparison
// or arithmetic computes a new value.
export const PASS_THROUGH =
  /(?:^|\.)(?:map|flatMap|filter|slice|concat|trim|trimStart|trimEnd|toLowerCase|toUpperCase|normalize|join|sort|toSorted|toString|padStart|padEnd|at|find|values|entries|replace|replaceAll|split|substring|substr|toLocaleLowerCase|toLocaleUpperCase)$|^(?:String|Object\.fromEntries|Object\.assign|Object\.values|Object\.entries|JSON\.stringify|Array\.from|structuredClone)$/;
// A variable copied whole by a pass-through method: `raw.trim()`, `list.slice()`, `names.join(',')`.
export const COPY_OF =
  /(?<![\w$.])([A-Za-z_$][\w$]*)\s*!?\s*(?:\?\.|\.)\s*(?:filter|slice|concat|trim|trimStart|trimEnd|toLowerCase|toUpperCase|normalize|join|sort|toSorted|toString|padStart|padEnd|at|find|values|entries|replace|replaceAll|split|substring|substr|toLocaleLowerCase|toLocaleUpperCase)\s*\(/g;
// Words an expression may hold that are not variables.
export const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'await', 'new', 'typeof', 'void', 'as', 'in', 'of', 'instanceof', 'satisfies', 'const', 'this']);

export const escape = (name: string) => name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

// The part of a name's initializer whose values the name holds: the branches of a choice, the whole of a path, a
// literal or a pass-through call, and null for a value computed from what it reads (`a !== b`, `count + 1`, `f(x)`).
export function heldPart(init: string): string | null {
  // A non-null assertion (`before!.tax_code`) is not a negation: it goes before the operators are read.
  const expr = unwrap(init.replace(/^await\s+/, ''))
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
export function objectish(expr: string): boolean {
  // Only an object that is the whole expression: `{ code: null }.code ?? party.tax_code` is a value.
  const bare = unwrap(expr);
  if (bare.startsWith('{')) return balanced(bare, 0) === bare;
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
export function unwrap(expr: string): string {
  let out = expr.trim();
  for (;;) {
    let next = out.replace(/!+$/, '').trim();
    if (next.startsWith('(') && balanced(next, 0) === next) next = next.slice(1, -1).trim();
    next = /^([A-Za-z_$][\w$.]*)!?\s+(?:as|satisfies)\s+/.exec(next)?.[1] ?? next;
    if (next === out) return out;
    out = next;
  }
}

// The properties of an object written out that no rule of the scan reads: anything but a spread, a shorthand, a named,
// numeric, quoted or computed key with its value, or a method (refused on its own).
export function unreadProperties(obj: string): string[] {
  return splitTop(obj.slice(1, -1))
    .map((p) => p.trim())
    .filter(
      (p) =>
        p !== '' &&
        // The rest of a type argument a comma split (`x as Record<string, unknown>`).
        !/^[\w$.[\]\s|&]*>+$/.test(p) &&
        !/^(?:\.\.\.|[A-Za-z_$][\w$]*$|(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|'[^']*'|"[^"]*"|\[[^]*\])\s*:|(?:async\s+|get\s+|set\s+|\*\s*)*(?:[A-Za-z_$][\w$]*|\[[^]*\])\s*\()/.test(p),
    );
}

// The variables an expression names: object keys, member reads, calls and keywords aside.
export function variables(expr: string): string[] {
  const keysBlanked = expr.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, (_, a: string, k: string, b: string) => `${a}${' '.repeat(k.length)}${b}`);
  return [...keysBlanked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b(?!\s*(?:[.([]|\?\.|!\s*[.[]))/g)].map((m) => m[1] as string).filter((n) => !KEYWORDS.has(n));
}

// A list split at its top-level commas (blanked code, so no string holds a comma).
export function splitTop(list: string): string[] {
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
