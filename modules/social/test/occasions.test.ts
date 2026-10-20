import { describe, expect, it } from 'vitest';
import { lunarToSolar, occasionsBetween } from '../src/domain/occasions.ts';

const dateOf = (id: string, year: number) => occasionsBetween(`${year}-01-01`, `${year}-12-31`).filter((o) => o.id === id).map((o) => o.date);

describe('Vietnamese occasions (#702)', () => {
  it('converts lunar days as the published Vietnamese calendar has them', () => {
    // Tết Nguyên Đán.
    expect(lunarToSolar(1, 1, 2024)).toEqual([10, 2, 2024]);
    expect(lunarToSolar(1, 1, 2025)).toEqual([29, 1, 2025]);
    expect(lunarToSolar(1, 1, 2026)).toEqual([17, 2, 2026]);
    expect(lunarToSolar(1, 1, 2027)).toEqual([6, 2, 2027]);
    expect(lunarToSolar(1, 1, 2028)).toEqual([26, 1, 2028]);
    expect(lunarToSolar(1, 1, 2029)).toEqual([13, 2, 2029]);
    // The new moon falls late on 2 February at UTC+7, early on 3 February in China: Vietnam's Tết comes a day sooner.
    expect(lunarToSolar(1, 1, 2030)).toEqual([2, 2, 2030]);
    // Trung thu; 2025 has a leap 6th month, so its 7th and 8th months come a month later.
    expect(lunarToSolar(15, 8, 2024)).toEqual([17, 9, 2024]);
    expect(lunarToSolar(15, 8, 2025)).toEqual([6, 10, 2025]);
    expect(lunarToSolar(15, 8, 2026)).toEqual([25, 9, 2026]);
    expect(lunarToSolar(15, 7, 2025)).toEqual([6, 9, 2025]);
    // Giỗ Tổ Hùng Vương.
    expect(lunarToSolar(10, 3, 2025)).toEqual([7, 4, 2025]);
    expect(lunarToSolar(10, 3, 2026)).toEqual([26, 4, 2026]);
  });

  it('lists each occasion on its day in a solar year, lunar ones included', () => {
    expect(dateOf('tet', 2026)).toEqual(['2026-02-17']);
    // Ông Công Ông Táo of the lunar year before falls in this solar year.
    expect(dateOf('kitchen_gods', 2025)).toEqual(['2025-01-22']);
    expect(dateOf('kitchen_gods', 2026)).toEqual(['2026-02-10']);
    expect(dateOf('mid_autumn', 2026)).toEqual(['2026-09-25']);
    expect(dateOf('women_day', 2026)).toEqual(['2026-03-08']);
    expect(dateOf('mothers_day', 2026)).toEqual(['2026-05-10']);
    expect(dateOf('fathers_day', 2026)).toEqual(['2026-06-21']);
    expect(dateOf('black_friday', 2026)).toEqual(['2026-11-27']);
    expect(dateOf('black_friday', 2027)).toEqual(['2027-11-26']);
  });

  it('keeps to the range, sorted, across a year end', () => {
    const list = occasionsBetween('2026-12-20', '2027-02-10');
    expect(list.map((o) => `${o.date} ${o.id}`)).toEqual([
      '2026-12-24 christmas',
      '2027-01-01 new_year',
      '2027-01-30 kitchen_gods',
      '2027-02-06 tet',
    ]);
    expect(list[3]?.kind).toBe('lunar');
    expect(occasionsBetween('2026-05-01', '2026-04-01')).toEqual([]);
    expect(occasionsBetween('x', 'y')).toEqual([]);
  });
});
