// A scripted scroll is smooth only when the system does not ask for reduced motion (DESIGN.md §7, #1605).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollBehavior } from '../src/lib/media.ts';

afterEach(() => vi.unstubAllGlobals());

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)' }) });
}

describe('scrollBehavior', () => {
  it('scrolls smoothly by default', () => {
    stubReducedMotion(false);
    expect(scrollBehavior()).toBe('smooth');
  });

  it('jumps when the system asks for reduced motion', () => {
    stubReducedMotion(true);
    expect(scrollBehavior()).toBe('auto');
  });

  it('scrolls smoothly where there is no window', () => {
    expect(scrollBehavior()).toBe('smooth');
  });
});
