// The legal entities card's helpers (issue #1278): which entities a form offers as the parent, and a parent's name.
import { describe, expect, it } from 'vitest';
import type { LegalEntity } from '@crove/kernel-contract';
import { parentChoices, parentName } from '../src/lib/legal-entities.ts';

const entity = (id: string, parentId: string | null, name = id): LegalEntity => ({
  id,
  name,
  kind: parentId ? 'branch' : 'company',
  taxCode: null,
  parentId,
  isDefault: parentId === null,
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
});

describe('legal entity parents', () => {
  // main <- a <- b, main <- c, d alone; listed out of tree order on purpose.
  const all = [entity('b', 'a'), entity('main', null, 'Công ty'), entity('c', 'main'), entity('a', 'main'), entity('d', null)];

  it('offers every entity for a new one', () => {
    expect(parentChoices(all, null).map((e) => e.id)).toEqual(['b', 'main', 'c', 'a', 'd']);
  });

  it('leaves out the entity itself and everything below it', () => {
    expect(parentChoices(all, 'main').map((e) => e.id)).toEqual(['d']);
    expect(parentChoices(all, 'a').map((e) => e.id)).toEqual(['main', 'c', 'd']);
    expect(parentChoices(all, 'b').map((e) => e.id)).toEqual(['main', 'c', 'a', 'd']);
  });

  it('names the parent, or nothing', () => {
    expect(parentName(all, entity('c', 'main'))).toBe('Công ty');
    expect(parentName(all, entity('d', null))).toBeNull();
    expect(parentName(all, entity('x', 'gone'))).toBeNull();
  });
});
