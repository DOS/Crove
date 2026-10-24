// Text variations (#1260): the rotation of up to 5 texts across evergreen and recurring copies, passing over one that
// X or LinkedIn would refuse as a repeat while another is left, the cursor after a person edits the list, the stored
// shape, and the contract's shape.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SOCIAL_TEXT_VARIATIONS_MAX, zSocialTextVariations } from '@crove/kernel-contract';
import { TEXT_VARIATIONS_MAX, cursorAfterEdit, cursorOf, keepAiMarks, parseTextVariations, pickVariation, variationOrder, type TextVariation } from '../src/index.ts';

const v = (text: string, ai = false): TextVariation => ({ text, ai });

describe('rotation', () => {
  it('takes variations 1, 2 and 3, then 1 again', () => {
    let cursor = 0;
    const taken: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const pick = pickVariation(3, cursor, () => false);
      if (!pick) throw new Error('no pick');
      taken.push(pick.index);
      cursor = pick.next;
    }
    expect(taken).toEqual([0, 1, 2, 0]);
    expect(cursor).toBe(1);
  });

  it('passes over a text that would repeat while another is left, and takes the cursor one when none is', () => {
    expect(pickVariation(3, 0, (i) => i === 0)).toEqual({ index: 1, next: 2 });
    expect(pickVariation(3, 2, (i) => i !== 1)).toEqual({ index: 1, next: 2 });
    expect(pickVariation(3, 1, () => true)).toEqual({ index: 1, next: 2 });
    expect(pickVariation(0, 0, () => false)).toBeNull();
  });

  it('tries every position once, from the cursor, wrapping; a cursor out of range starts at the first', () => {
    expect(variationOrder(4, 2)).toEqual([2, 3, 0, 1]);
    expect(variationOrder(0, 3)).toEqual([]);
    expect(cursorOf(3, 7)).toBe(1);
    expect(cursorOf(3, -1)).toBe(0);
    expect(cursorOf(0, 2)).toBe(0);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: TEXT_VARIATIONS_MAX }), fc.integer({ min: 0, max: 20 }), (count, cursor) => {
        const order = variationOrder(count, cursor);
        expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
        const pick = pickVariation(count, cursor, () => false);
        expect(pick?.index).toBe(order[0]);
        expect(pick?.next).toBe(((order[0] as number) + 1) % count);
      }),
    );
  });

  it('never repeats a text while one that does not is left', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: TEXT_VARIATIONS_MAX }), fc.integer({ min: 0, max: 4 }), fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }), (count, cursor, flags) => {
        const repeats = (i: number) => flags[i] === true;
        const pick = pickVariation(count, cursor, repeats);
        const free = Array.from({ length: count }, (_, i) => i).some((i) => !repeats(i));
        expect(pick && repeats(pick.index)).toBe(free ? false : true);
      }),
    );
  });
});

describe('editing the list', () => {
  it('keeps the cursor on the text it named when that text moved or others were added or removed', () => {
    const before = [v('A'), v('B'), v('C')];
    expect(cursorAfterEdit(before, 1, [v('C'), v('B'), v('A')])).toBe(1);
    expect(cursorAfterEdit(before, 2, [v('C'), v('A')])).toBe(0);
    expect(cursorAfterEdit(before, 1, [v('X'), v('Y'), v('B')])).toBe(2);
    // Its text gone: the same position when the list is still that long, else the first.
    expect(cursorAfterEdit(before, 1, [v('A'), v('D'), v('C')])).toBe(1);
    expect(cursorAfterEdit(before, 2, [v('A'), v('B')])).toBe(0);
    expect(cursorAfterEdit(before, 0, [])).toBe(0);
    expect(cursorAfterEdit([], 0, [v('A')])).toBe(0);
  });

  it('never drops the AI mark from a text that had it', () => {
    expect(keepAiMarks([v('A', true), v('B')], [v('B'), v('A'), v('C', true)])).toEqual([v('B'), v('A', true), v('C', true)]);
  });
});

describe('stored shape', () => {
  it('reads the list the commands write, and nothing else', () => {
    expect(parseTextVariations([{ text: 'Một', ai: false }, { text: 'Hai', ai: true }])).toEqual([v('Một'), v('Hai', true)]);
    expect(parseTextVariations([])).toEqual([]);
    for (const bad of [null, {}, 'x', [{ text: 'A' }], [{ text: 'A', ai: 'no' }], [{ text: '   ', ai: false }], [{ text: 1, ai: false }], [v('A'), v('A')], Array.from({ length: 6 }, (_, i) => v(`T${i}`)), [null]]) {
      expect(parseTextVariations(bad), JSON.stringify(bad)).toEqual([]);
    }
  });

  it('is refused by the contract unless it is up to 5 different texts with something to say', () => {
    expect(SOCIAL_TEXT_VARIATIONS_MAX).toBe(TEXT_VARIATIONS_MAX);
    expect(zSocialTextVariations.parse([{ text: '  Một  ', ai: false }])).toEqual([v('Một')]);
    expect(zSocialTextVariations.safeParse(Array.from({ length: 6 }, (_, i) => v(`T${i}`))).success).toBe(false);
    expect(zSocialTextVariations.safeParse([v('A'), v(' A ')]).success).toBe(false);
    expect(zSocialTextVariations.safeParse([v('   ')]).success).toBe(false);
    expect(zSocialTextVariations.safeParse([{ text: 'A', ai: false, extra: 1 }]).success).toBe(false);
    expect(zSocialTextVariations.safeParse([v('x'.repeat(100_001))]).success).toBe(false);
  });
});
