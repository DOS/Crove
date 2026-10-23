// Who follows an account (#1146): the age, gender, cities and countries of its followers, as Instagram
// (follower_demographics on the account's insights) and Threads (follower_demographics on threads_insights) give them.
// Both answer a total_value with one breakdown per call; only followers whose details the platform knows are counted,
// so the shares can add up to fewer than the followers. Neither gives it under 100 followers.

// The breakdowns Crove asks for, by the name the platforms use.
export const AUDIENCE_BREAKDOWNS = ['age', 'gender', 'city', 'country'] as const;
export type AudienceBreakdown = (typeof AUDIENCE_BREAKDOWNS)[number];
// The platforms give no demographics below this many followers; Crove does not ask then.
export const AUDIENCE_MIN_FOLLOWERS = 100;
// Cities and countries kept, the largest first (the platforms give up to 45).
export const AUDIENCE_TOP = 10;
// Age buckets and genders kept at most; the platforms give 7 buckets and 3 genders.
const AUDIENCE_SMALL_MAX = 12;
// A key longer than this is left out: a city's name with its region, or a short code for the others.
export const AUDIENCE_CITY_MAX = 100;
export const AUDIENCE_KEY_MAX = 40;

// One share of the followers: an age bucket ("18-24", "65+"), a gender ("F", "M", "U"), a city as the platform names
// it ("Hanoi, Hanoi"), or a country's ISO 3166-1 alpha-2 code ("VN"); count is how many followers it holds.
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

interface BreakdownAnswer {
  data?: { name?: unknown; total_value?: { breakdowns?: { dimension_keys?: unknown; results?: { dimension_values?: unknown; value?: unknown }[] }[] } }[];
}

const KEY = /^[^\p{Cc}]+$/u;

// The slices of one breakdown's answer, the largest first, the keys checked; a key given twice is added up. The
// breakdown's own value is found by its place in dimension_keys (Instagram puts the timeframe first), the last one
// when the answer names no keys; an answer whose keys leave the breakdown out gives none.
export function audienceSlices(answer: unknown, breakdown: AudienceBreakdown): AudienceSlice[] {
  const rows = (answer as BreakdownAnswer | null)?.data;
  const row = Array.isArray(rows) ? rows.find((r) => r?.name === 'follower_demographics') : undefined;
  const block = row?.total_value?.breakdowns?.[0];
  const results = Array.isArray(block?.results) ? block.results : [];
  const keys = Array.isArray(block?.dimension_keys) ? (block.dimension_keys as unknown[]) : [];
  const at = keys.indexOf(breakdown);
  // An answer that names its keys but not this breakdown is about something else.
  if (at === -1 && keys.length > 0) return [];
  const sums = new Map<string, number>();
  for (const r of results.slice(0, 500)) {
    const values = Array.isArray(r?.dimension_values) ? (r.dimension_values as unknown[]) : [];
    const raw = at >= 0 ? values[at] : values.at(-1);
    const value = r?.value;
    if (typeof raw !== 'string' || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue;
    const key = raw.trim();
    if (!key || key.length > (breakdown === 'city' ? AUDIENCE_CITY_MAX : AUDIENCE_KEY_MAX) || !KEY.test(key)) continue;
    sums.set(key, (sums.get(key) ?? 0) + value);
  }
  const max = breakdown === 'city' || breakdown === 'country' ? AUDIENCE_TOP : AUDIENCE_SMALL_MAX;
  return [...sums]
    .map(([key, count]) => ({ key, count }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
    .slice(0, max);
}

// The audience from each breakdown's slices; null when none of them gave anything.
export function audienceOf(parts: Partial<Record<AudienceBreakdown, AudienceSlice[]>>): Audience | null {
  const audience: Audience = { age: parts.age ?? [], gender: parts.gender ?? [], cities: parts.city ?? [], countries: parts.country ?? [] };
  return audience.age.length + audience.gender.length + audience.cities.length + audience.countries.length === 0 ? null : audience;
}
