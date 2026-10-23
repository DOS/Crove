// Who follows a channel's account (#1146), as the Metrics tab and the client report show it: the age buckets in age
// order, the genders, and the largest cities and countries, each with its share of the followers the platform counted.

export interface AudienceSlice {
  key: string;
  count: number;
}
export interface Audience {
  age: AudienceSlice[];
  gender: AudienceSlice[];
  cities: AudienceSlice[];
  countries: AudienceSlice[];
}
export interface AudienceShare {
  key: string;
  count: number;
  // Of the followers counted in this breakdown, 0 to 100.
  percent: number;
}

// Meta's age buckets, youngest first; any other bucket goes after them.
const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
const GENDER_ORDER = ['F', 'M', 'U'];
const LIST_MAX = 10;

const slicesOf = (value: unknown): AudienceSlice[] =>
  Array.isArray(value)
    ? value
        .filter((s): s is AudienceSlice => typeof s === 'object' && s !== null && typeof (s as AudienceSlice).key === 'string' && typeof (s as AudienceSlice).count === 'number' && Number.isFinite((s as AudienceSlice).count) && (s as AudienceSlice).count >= 0)
        .slice(0, 50)
        .map((s) => ({ key: s.key.slice(0, 100), count: s.count }))
    : [];

// An audience as a server sent it, read again; null when it holds nothing to show.
export function audienceOf(value: unknown): Audience | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const audience = { age: slicesOf(v.age), gender: slicesOf(v.gender), cities: slicesOf(v.cities), countries: slicesOf(v.countries) };
  return audience.age.length + audience.gender.length + audience.cities.length + audience.countries.length === 0 ? null : audience;
}

const rank = (order: readonly string[], key: string) => {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
};

// Each slice's share of the breakdown, in the order it is shown: ages youngest first, genders women, men, unknown, and
// cities and countries largest first (the ten largest). Shares are rounded to one decimal.
export function sharesOf(slices: readonly AudienceSlice[], kind: 'age' | 'gender' | 'cities' | 'countries'): AudienceShare[] {
  const total = slices.reduce((sum, s) => sum + s.count, 0);
  if (total <= 0) return [];
  const sorted = [...slices];
  if (kind === 'age') sorted.sort((a, b) => rank(AGE_ORDER, a.key) - rank(AGE_ORDER, b.key) || a.key.localeCompare(b.key));
  else if (kind === 'gender') sorted.sort((a, b) => rank(GENDER_ORDER, a.key) - rank(GENDER_ORDER, b.key) || b.count - a.count);
  else sorted.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return sorted.slice(0, kind === 'cities' || kind === 'countries' ? LIST_MAX : sorted.length).map((s) => ({ key: s.key, count: s.count, percent: Math.round((s.count / total) * 1000) / 10 }));
}

// A country's name in the reader's language from its ISO code, the code itself when the browser does not know it.
export function countryName(code: string, locale: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
