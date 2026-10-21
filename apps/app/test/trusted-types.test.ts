// The SPA runs under Trusted Types with no policy (#681): every HTML or script sink refuses a string. React renders
// without them; this keeps the sources from reaching one directly, where it would throw in the browser. Code that
// truly needs raw HTML has to come with a named Trusted Types policy and a change to the kernel's CSP.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// The SPA and the packages it renders from.
const SCANNED = ['apps/app/src', 'packages/ui/src'];
const SINK = /dangerouslySetInnerHTML|\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\bsrcdoc\b|createContextualFragment|\beval\s*\(|new\s+Function\s*\(|\.setHTMLUnsafe\s*\(/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx|js|jsx)$/.test(name) ? [path] : [];
  });
}

describe('Trusted Types in the SPA', () => {
  it('reaches no HTML or script sink from its sources', () => {
    const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(SINK)].map((m) => `${relative(ROOT, path)}: ${m[0]}`),
    );
    expect(offenders, 'a DOM sink fails under Trusted Types: render through React instead').toEqual([]);
  });

  it('recognises the sinks it forbids', () => {
    const text = 'el.innerHTML = s; <div dangerouslySetInnerHTML={x} />; document.write(s); eval(s); new Function(s); el.insertAdjacentHTML("x", s)';
    expect([...text.matchAll(SINK)].map((m) => m[0].replace(/\s+/g, ''))).toEqual([
      '.innerHTML=',
      'dangerouslySetInnerHTML',
      'document.write',
      'eval(',
      'newFunction(',
      'insertAdjacentHTML',
    ]);
  });
});
