// The legal entity the finance screens work in (#1486): which one, and where the switcher shows.
import { afterEach, describe, expect, it } from 'vitest';
import { chooseEntity, isFinanceBookPath, keepEntity, keptEntity, type VisibleEntity } from '../src/lib/legal-entity-choice.ts';

const e = (id: string, isDefault = false): VisibleEntity => ({ id, name: `Pháp nhân ${id}`, isDefault });

describe('legal entity choice', () => {
  afterEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // No storage in this environment.
    }
  });

  it('keeps the chosen entity while the caller sees it, else falls back to the default, else the first', () => {
    const all = [e('a'), e('b', true), e('c')];
    expect(chooseEntity(all, 'c')).toBe('c');
    // Removed, or out of the caller's scope since: the default entity.
    expect(chooseEntity(all, 'gone')).toBe('b');
    expect(chooseEntity(all, null)).toBe('b');
    // A caller limited to entities without the default one: the first they see.
    expect(chooseEntity([e('a'), e('c')], null)).toBe('a');
    expect(chooseEntity([], 'a')).toBeNull();
  });

  it('shows on the finance books screens only', () => {
    for (const path of ['/o/acme/journal', '/o/acme/journal/opening-balances', '/o/acme/ledger', '/o/acme/vat', '/o/acme/documents', '/o/acme/bank', '/o/acme/vouchers', '/o/acme/fixed-assets']) {
      expect(isFinanceBookPath(path), path).toBe(true);
    }
    for (const path of ['/o/acme/inbox', '/o/acme/settings', '/o/acme/social', '/clients', '/o/acme', '/journal']) {
      expect(isFinanceBookPath(path), path).toBe(false);
    }
  });

  it('keeps one choice per org', () => {
    keepEntity('acme', 'a');
    keepEntity('beta', 'b');
    expect(keptEntity('acme')).toBe('a');
    expect(keptEntity('beta')).toBe('b');
    expect(keptEntity('other')).toBeNull();
  });
});
