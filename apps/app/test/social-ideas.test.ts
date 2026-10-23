import { describe, expect, it } from 'vitest';
import { BOARD_STAGES, OCCASION_MAX, SUGGEST_COUNTS, ideasOccasion, linkHost } from '../src/lib/social-ideas.ts';

describe('AI post ideas (#1181)', () => {
  it('asks for 3 to 10 ideas', () => {
    expect(SUGGEST_COUNTS[0]).toBe(3);
    expect(SUGGEST_COUNTS.at(-1)).toBe(10);
  });

  it('tells the AI the label, its dates and the occasion on one short line', () => {
    expect(ideasOccasion(null, '  ')).toBeUndefined();
    expect(ideasOccasion(null, 'Tết\nTrung thu')).toBe('Tết Trung thu');
    expect(ideasOccasion({ name: 'Ra mắt thu', startsOn: '2026-11-01', endsOn: '2026-11-30' }, '')).toBe('Ra mắt thu (from 2026-11-01 to 2026-11-30)');
    expect(ideasOccasion({ name: 'Ra mắt thu', startsOn: null, endsOn: '2026-11-30' }, 'Black Friday')).toBe('Ra mắt thu (to 2026-11-30); Black Friday');
    expect(ideasOccasion({ name: 'Khách quen', startsOn: null, endsOn: null }, '')).toBe('Khách quen');
    const long = ideasOccasion({ name: '😀'.repeat(150), startsOn: null, endsOn: null }, '') ?? '';
    expect(long.length).toBeLessThanOrEqual(OCCASION_MAX);
    expect(long).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe('ideas board (#701)', () => {
  it('shows new, planned and drafted ideas as columns, archived ones apart', () => {
    expect(BOARD_STAGES).toEqual(['new', 'planned', 'drafted']);
  });

  it('shows a link by its site', () => {
    expect(linkHost('https://www.cuahang.vn/khuyen-mai?x=1')).toBe('cuahang.vn');
    expect(linkHost('https://shop.example/a')).toBe('shop.example');
    expect(linkHost('không phải link')).toBe('không phải link');
  });
});
