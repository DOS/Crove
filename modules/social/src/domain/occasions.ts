// Vietnamese marketing occasions (#702): the days a Vietnamese shop plans posts around, for the Social calendar. Fixed
// days of the solar calendar (8/3, 30/4, 20/10, the double-day sales...), days counted from a month (Mother's Day,
// Black Friday), and days of the lunar calendar (Tết, Trung thu...), converted with the Vietnamese lunar calendar
// computed at UTC+7, after Hồ Ngọc Đức's published algorithm (astronomical new moons and solar terms), so no date is
// typed by hand. The names live in the app's strings, by id.

export type OccasionKind = 'holiday' | 'shopping' | 'lunar';

export interface OccasionRule {
  id: string;
  kind: OccasionKind;
  // A solar day, a weekday counted in a month (weekday 1 is Monday; nth -1 is the last), or a lunar day.
  rule: { solar: [month: number, day: number] } | { nthWeekday: [month: number, weekday: number, nth: number] } | { lunar: [month: number, day: number] };
}

export const OCCASIONS: readonly OccasionRule[] = [
  { id: 'new_year', kind: 'holiday', rule: { solar: [1, 1] } },
  { id: 'valentine', kind: 'shopping', rule: { solar: [2, 14] } },
  { id: 'women_day', kind: 'holiday', rule: { solar: [3, 8] } },
  { id: 'reunification', kind: 'holiday', rule: { solar: [4, 30] } },
  { id: 'labour_day', kind: 'holiday', rule: { solar: [5, 1] } },
  { id: 'mothers_day', kind: 'shopping', rule: { nthWeekday: [5, 7, 2] } },
  { id: 'children_day', kind: 'holiday', rule: { solar: [6, 1] } },
  { id: 'fathers_day', kind: 'shopping', rule: { nthWeekday: [6, 7, 3] } },
  { id: 'national_day', kind: 'holiday', rule: { solar: [9, 2] } },
  { id: 'sale_9_9', kind: 'shopping', rule: { solar: [9, 9] } },
  { id: 'sale_10_10', kind: 'shopping', rule: { solar: [10, 10] } },
  { id: 'vietnam_women_day', kind: 'holiday', rule: { solar: [10, 20] } },
  { id: 'halloween', kind: 'shopping', rule: { solar: [10, 31] } },
  { id: 'sale_11_11', kind: 'shopping', rule: { solar: [11, 11] } },
  { id: 'teachers_day', kind: 'holiday', rule: { solar: [11, 20] } },
  { id: 'black_friday', kind: 'shopping', rule: { nthWeekday: [11, 5, 4] } },
  { id: 'sale_12_12', kind: 'shopping', rule: { solar: [12, 12] } },
  { id: 'christmas', kind: 'holiday', rule: { solar: [12, 24] } },
  { id: 'tet', kind: 'lunar', rule: { lunar: [1, 1] } },
  { id: 'first_full_moon', kind: 'lunar', rule: { lunar: [1, 15] } },
  { id: 'hung_kings', kind: 'lunar', rule: { lunar: [3, 10] } },
  { id: 'vu_lan', kind: 'lunar', rule: { lunar: [7, 15] } },
  { id: 'mid_autumn', kind: 'lunar', rule: { lunar: [8, 15] } },
  { id: 'kitchen_gods', kind: 'lunar', rule: { lunar: [12, 23] } },
];

export interface Occasion {
  id: string;
  kind: OccasionKind;
  // The day, YYYY-MM-DD.
  date: string;
}

// ---- The Vietnamese lunar calendar (time zone +7) ----

const TZ = 7;
const { PI, floor, sin } = Math;

function jdFromDate(day: number, month: number, year: number): number {
  const a = floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const jd = day + floor((153 * m + 2) / 5) + 365 * y + floor(y / 4) - floor(y / 100) + floor(y / 400) - 32045;
  return jd < 2299161 ? day + floor((153 * m + 2) / 5) + 365 * y + floor(y / 4) - 32083 : jd;
}

function jdToDate(jd: number): [day: number, month: number, year: number] {
  let b: number;
  let c: number;
  if (jd > 2299160) {
    const a = jd + 32044;
    b = floor((4 * a + 3) / 146097);
    c = a - floor((b * 146097) / 4);
  } else {
    b = 0;
    c = jd + 32082;
  }
  const d = floor((4 * c + 3) / 1461);
  const e = c - floor((1461 * d) / 4);
  const m = floor((5 * e + 2) / 153);
  return [e - floor((153 * m + 2) / 5) + 1, m + 3 - 12 * floor(m / 10), b * 100 + d - 4800 + floor(m / 10)];
}

// The k-th new moon after 1900-01-01, as a Julian day.
function newMoon(k: number): number {
  const T = k / 1236.85;
  const T2 = T * T;
  const T3 = T2 * T;
  const dr = PI / 180;
  let jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
  jd1 += 0.00033 * sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
  const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
  const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
  const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
  let c1 = (0.1734 - 0.000393 * T) * sin(M * dr) + 0.0021 * sin(2 * dr * M);
  c1 = c1 - 0.4068 * sin(Mpr * dr) + 0.0161 * sin(dr * 2 * Mpr);
  c1 = c1 - 0.0004 * sin(dr * 3 * Mpr);
  c1 = c1 + 0.0104 * sin(dr * 2 * F) - 0.0051 * sin(dr * (M + Mpr));
  c1 = c1 - 0.0074 * sin(dr * (M - Mpr)) + 0.0004 * sin(dr * (2 * F + M));
  c1 = c1 - 0.0004 * sin(dr * (2 * F - M)) - 0.0006 * sin(dr * (2 * F + Mpr));
  c1 = c1 + 0.001 * sin(dr * (2 * F - Mpr)) + 0.0005 * sin(dr * (2 * Mpr + M));
  const deltaT = T < -11 ? 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3 : -0.000278 + 0.000265 * T + 0.000262 * T2;
  return jd1 + c1 - deltaT;
}

// The sun's longitude at a Julian day, in radians.
function sunLongitude(jdn: number): number {
  const T = (jdn - 2451545.0) / 36525;
  const T2 = T * T;
  const dr = PI / 180;
  const M = 357.5291 + 35999.0503 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
  const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
  let dl = (1.9146 - 0.004817 * T - 0.000014 * T2) * sin(dr * M);
  dl = dl + (0.019993 - 0.000101 * T) * sin(dr * 2 * M) + 0.00029 * sin(dr * 3 * M);
  let L = (L0 + dl) * dr;
  L = L - PI * 2 * floor(L / (PI * 2));
  return L;
}

const newMoonDay = (k: number) => floor(newMoon(k) + 0.5 + TZ / 24);
// Which of the 12 solar-term sectors the sun is in at the start of a local day.
const sunSector = (dayNumber: number) => floor((sunLongitude(dayNumber - 0.5 - TZ / 24) / PI) * 6);

// The day the 11th lunar month (the one holding the winter solstice) of a year starts.
function lunarMonth11(year: number): number {
  const off = jdFromDate(31, 12, year) - 2415021;
  const k = floor(off / 29.530588853);
  const nm = newMoonDay(k);
  return sunSector(nm) >= 9 ? newMoonDay(k - 1) : nm;
}

// In a 13-month lunar year, which month after the 11th is the leap month (the first with no solar term).
function leapMonthOffset(a11: number): number {
  const k = floor((a11 - 2415021.076998695) / 29.530588853 + 0.5);
  let i = 1;
  let arc = sunSector(newMoonDay(k + i));
  let last: number;
  do {
    last = arc;
    i++;
    arc = sunSector(newMoonDay(k + i));
  } while (arc !== last && i < 14);
  return i - 1;
}

// A day of the lunar calendar (not a leap month) as a solar date.
export function lunarToSolar(lunarDay: number, lunarMonth: number, lunarYear: number): [day: number, month: number, year: number] {
  const [a11, b11] = lunarMonth < 11 ? [lunarMonth11(lunarYear - 1), lunarMonth11(lunarYear)] : [lunarMonth11(lunarYear), lunarMonth11(lunarYear + 1)];
  const k = floor(0.5 + (a11 - 2415021.076998695) / 29.530588853);
  let off = lunarMonth - 11;
  if (off < 0) off += 12;
  // A 13-month year: the months from the leap one on start a month later.
  if (b11 - a11 > 365 && off >= leapMonthOffset(a11)) off += 1;
  return jdToDate(newMoonDay(k + off) + lunarDay - 1);
}

// ---- Occasions in a range ----

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

// The nth weekday (1 Monday .. 7 Sunday) of a month; nth -1 is the last.
function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay() || 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (nth > 0) return 1 + ((weekday - first + 7) % 7) + 7 * (nth - 1);
  const last = new Date(Date.UTC(year, month - 1, days)).getUTCDay() || 7;
  return days - ((last - weekday + 7) % 7);
}

function datesIn(year: number, o: OccasionRule): string[] {
  const r = o.rule;
  if ('solar' in r) return [ymd(year, r.solar[0], r.solar[1])];
  if ('nthWeekday' in r) return [ymd(year, r.nthWeekday[0], nthWeekday(year, r.nthWeekday[0], r.nthWeekday[1], r.nthWeekday[2]))];
  // A lunar day may fall in this solar year from this lunar year or the one before (the 12th month).
  return [year - 1, year].map((ly) => lunarToSolar(r.lunar[1], r.lunar[0], ly)).filter(([, , y]) => y === year).map(([d, m, y]) => ymd(y, m, d));
}

// The occasions from `from` to `to` (YYYY-MM-DD, both included), by date.
export function occasionsBetween(from: string, to: string, rules: readonly OccasionRule[] = OCCASIONS): Occasion[] {
  const y0 = Number(from.slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  if (!Number.isInteger(y0) || !Number.isInteger(y1) || y1 < y0 || y1 - y0 > 10) return [];
  const out: Occasion[] = [];
  for (let y = y0; y <= y1; y++) {
    for (const o of rules) for (const date of datesIn(y, o)) if (date >= from && date <= to) out.push({ id: o.id, kind: o.kind, date });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
