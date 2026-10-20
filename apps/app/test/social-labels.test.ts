import { describe, expect, it } from 'vitest';
import { SOCIAL_LABEL_COLORS } from '@crove/kernel-contract';
import { LABEL_SWATCH, LABEL_TONE, MAX_LABELS_PER_POST, isLabelColor, labelsOf, toggleLabel } from '../src/lib/social-labels.ts';

describe('post labels (#639)', () => {
  it('turns a label on or off, up to the per-post limit', () => {
    expect(toggleLabel([], 'a')).toEqual(['a']);
    expect(toggleLabel(['a', 'b'], 'a')).toEqual(['b']);
    const full = Array.from({ length: MAX_LABELS_PER_POST }, (_, i) => `l${i}`);
    expect(toggleLabel(full, 'new')).toBeNull();
    // Turning one off still works at the limit.
    expect(toggleLabel(full, 'l0')).toHaveLength(MAX_LABELS_PER_POST - 1);
  });

  it("shows a post's labels in the org's order and skips deleted ones", () => {
    const labels = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    expect(labelsOf(['c', 'gone', 'a'], labels).map((l) => l.id)).toEqual(['a', 'c']);
    expect(labelsOf([], labels)).toEqual([]);
  });

  it('has a theme tone for every colour the server accepts', () => {
    expect(Object.keys(LABEL_TONE).sort()).toEqual([...SOCIAL_LABEL_COLORS].sort());
    expect(Object.keys(LABEL_SWATCH).sort()).toEqual([...SOCIAL_LABEL_COLORS].sort());
    expect(isLabelColor('teal')).toBe(true);
    expect(isLabelColor('magenta')).toBe(false);
  });
});
