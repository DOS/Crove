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
