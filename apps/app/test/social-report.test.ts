import { describe, expect, it } from 'vitest';
import { REPORT_BLOCKS, defaultSections, draftOf, hasBlock, lastMonth, moveBlock, pageBlocks, parseRecipients, reportPeriod, reportUrl, sectionsOf, topCountOf } from '../src/lib/social-report.ts';

describe('client report links (#643)', () => {
  it('suggests the previous calendar month, across a year end', () => {
    expect(lastMonth(new Date(2026, 9, 20))).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(lastMonth(new Date(2026, 0, 5))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(lastMonth(new Date(2024, 2, 1))).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('covers the whole of both days in the browser zone', () => {
    const p = reportPeriod('2026-10-01', '2026-10-31');
    expect(p).not.toBeNull();
    const start = new Date(p?.periodStart as string);
    const end = new Date(p?.periodEnd as string);
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([2026, 9, 1, 0]);
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours()]).toEqual([2026, 10, 1, 0]);
    expect(reportPeriod('2026-10-05', '2026-10-05')).not.toBeNull();
  });

  it('refuses a missing date or a last day before the first', () => {
    expect(reportPeriod('', '2026-10-31')).toBeNull();
    expect(reportPeriod('2026-10-31', '2026-10-01')).toBeNull();
    expect(reportPeriod('31/10/2026', '2026-11-01')).toBeNull();
  });

  it('keeps the token after the #', () => {
    expect(reportUrl('https://app.crove.test', 'a'.repeat(43))).toBe(`https://app.crove.test/-/report#${'a'.repeat(43)}`);
  });
});

describe('report schedule recipients (#704)', () => {
  it('splits on commas, semicolons and new lines, lower-cases, drops duplicates and names the invalid ones', () => {
    expect(parseRecipients(' Khach@Example.vn, sep@example.vn;\nkhach@example.vn  sai-dia-chi ')).toEqual({ valid: ['khach@example.vn', 'sep@example.vn'], invalid: ['sai-dia-chi'] });
    expect(parseRecipients('')).toEqual({ valid: [], invalid: [] });
  });
});

describe('client report sections (#1259)', () => {
  it('shows every block in the page order without sections, else the chosen blocks in their order', () => {
    expect(pageBlocks(null)).toEqual([...REPORT_BLOCKS]);
    expect(pageBlocks(undefined)).toEqual([...REPORT_BLOCKS]);
    expect(pageBlocks(['top', 'stories', 'note', 'nonsense', 'top'])).toEqual(['top', 'note']);
    expect(pageBlocks([])).toEqual([]);
  });

  it('saves nothing for an untouched form, so the report stays as before', () => {
    expect(sectionsOf(defaultSections())).toBeNull();
    expect(topCountOf(defaultSections())).toBeNull();
  });

  it('saves the ticked blocks in their order, then the extras, and the count only when it is not 10', () => {
    const d = defaultSections();
    const moved = { ...d, order: moveBlock(d.order, 'top', -1) };
    expect(sectionsOf(moved)).toEqual(['note', 'goals', 'totals', 'reels', 'top', 'channels', 'audience', 'comparison', 'stories', 'clicks']);
    const fewer = { ...d, on: new Set(['top', 'note', 'clicks'] as const), topCount: 5 };
    expect(sectionsOf(fewer)).toEqual(['note', 'top', 'clicks']);
    expect(topCountOf(fewer)).toBe(5);
    // Without the best posts, no count.
    expect(topCountOf({ ...fewer, on: new Set(['note'] as const) })).toBeNull();
    expect(sectionsOf({ ...d, on: new Set() })).toEqual([]);
    // The extras alone make an empty report: the form needs a block.
    expect(hasBlock({ ...d, on: new Set(['comparison', 'stories', 'clicks'] as const) })).toBe(false);
    expect(hasBlock(fewer)).toBe(true);
  });

  it('reads a saved list back into the form, and moves a block within bounds', () => {
    const d = draftOf(['top', 'note', 'stories'], 5);
    expect(d.order).toEqual(['top', 'note', 'goals', 'totals', 'reels', 'channels', 'audience']);
    expect([...d.on]).toEqual(['top', 'note', 'stories']);
    expect(sectionsOf(d)).toEqual(['top', 'note', 'stories']);
    expect(draftOf(null, null)).toEqual(defaultSections());
    expect(moveBlock(['note', 'goals'], 'note', -1)).toEqual(['note', 'goals']);
    expect(moveBlock(['note', 'goals'], 'goals', 1)).toEqual(['note', 'goals']);
    expect(moveBlock(['note', 'goals'], 'goals', -1)).toEqual(['goals', 'note']);
  });
});
