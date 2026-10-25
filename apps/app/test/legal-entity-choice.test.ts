// The legal entity the finance screens work in (#1486): which one, and where the switcher shows.
import { afterEach, describe, expect, it } from 'vitest';
import { chooseEntity, exportQuery, isEntityPath, keepEntity, keptEntity, proposalEntity, type VisibleEntity } from '../src/lib/legal-entity-choice.ts';

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

  it('shows on the finance books, the Overview and Settings only', () => {
    for (const path of ['/o/acme/journal', '/o/acme/journal/opening-balances', '/o/acme/ledger', '/o/acme/vat', '/o/acme/documents', '/o/acme/bank', '/o/acme/vouchers', '/o/acme/fixed-assets', '/o/acme/portal-invoices', '/o/acme/overview', '/o/acme/settings']) {
      expect(isEntityPath(path), path).toBe(true);
    }
    for (const path of ['/o/acme/inbox', '/o/acme/tasks', '/o/acme/social', '/clients', '/o/acme', '/journal']) {
      expect(isEntityPath(path), path).toBe(false);
    }
  });

  it('adds the chosen entity to an export download, and nothing without one', () => {
    expect(exportQuery({ period: '2026-09' }, 'e1').toString()).toBe('period=2026-09&legalEntityId=e1');
    // No entity seen (an empty or failed list): the server answers for the default entity.
    expect(exportQuery({ period: '2026-09' }, undefined).toString()).toBe('period=2026-09');
    expect(exportQuery({}, 'e1').toString()).toBe('legalEntityId=e1');
  });

  it('shows the entity a proposal is recorded in, and suggests the shell choice only for one that names none (#1542)', () => {
    const all = [e('a'), e('b', true), e('c')];
    // Named by a revision: that entity, and nothing to suggest.
    expect(proposalEntity(all, 'c', 'a')).toEqual({ effective: 'c', suggest: null });
    // Not named: the default entity, and the shell's other choice is suggested.
    expect(proposalEntity(all, null, 'a')).toEqual({ effective: 'b', suggest: 'a' });
    expect(proposalEntity(all, null, 'b')).toEqual({ effective: 'b', suggest: null });
    // Named but not visible to the caller: shown as the default, never suggested over.
    expect(proposalEntity(all, 'gone', 'a')).toEqual({ effective: 'b', suggest: null });
    // A choice the caller no longer sees is never offered.
    expect(proposalEntity(all, null, 'gone')).toEqual({ effective: 'b', suggest: null });
    expect(proposalEntity([], null, null)).toEqual({ effective: null, suggest: null });
  });

  it('keeps one choice per org', () => {
    keepEntity('acme', 'a');
    keepEntity('beta', 'b');
    expect(keptEntity('acme')).toBe('a');
    expect(keptEntity('beta')).toBe('b');
    expect(keptEntity('other')).toBeNull();
  });
});
