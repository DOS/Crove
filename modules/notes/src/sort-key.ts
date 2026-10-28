// Fractional order keys for a member's own to-do list (issue #1673, notes.md §3.4 `sort_key`). A key is a string of
// the 62 digits below, read as the digits after the point of a fraction in base 62, and keys compare byte by byte
// (the column is COLLATE "C"), which is the order of those fractions. Between any two keys there is another, so a move
// rewrites one row only. Keys this code makes never end in '0' (the same fraction as the key without it), so two of
// them are never equal as fractions; a key from elsewhere that does is still ordered correctly.
export const SORT_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = SORT_DIGITS.length;
// The longest key the table accepts (its CHECK). A list whose keys grow past REBALANCE_AT is given fresh keys.
export const SORT_KEY_MAX = 200;
export const REBALANCE_AT = 48;

const digit = (c: string | undefined): number => (c === undefined ? 0 : SORT_DIGITS.indexOf(c));

/** True for a key the table accepts. */
export function isSortKey(key: string): boolean {
  return key.length >= 1 && key.length <= SORT_KEY_MAX && [...key].every((c) => SORT_DIGITS.includes(c));
}

// A key strictly between a (the empty string is 0) and b (null is 1), with a < b as fractions.
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // The digits both share stay; the key is decided after them.
    let n = 0;
    while (n < b.length && (a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const lo = digit(a[0]);
  const hi = b === null ? BASE : digit(b[0]);
  if (hi - lo > 1) return SORT_DIGITS[Math.floor((lo + hi) / 2)] as string;
  // Adjacent first digits. When b goes on after its first digit, that digit alone lies between them.
  if (b !== null && b.length > 1) return b[0] as string;
  return (SORT_DIGITS[lo] as string) + midpoint(a.slice(1), null);
}

/**
 * A key that sorts after `before` and before `after` (null: no neighbor on that side). Throws when `before` does not
 * sort before `after`, so a caller with two equal keys gives the list fresh keys first.
 */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && !(before < after)) throw new Error('keyBetween: the keys are not in order');
  return midpoint(before ?? '', after);
}

/** `n` keys in order, evenly spread and short, for a list given fresh keys. */
export function spreadKeys(n: number): string[] {
  let width = 1;
  while (BASE ** width <= n) width++;
  const step = BASE ** width / (n + 1);
  return Array.from({ length: n }, (_, i) => {
    let value = Math.floor(step * (i + 1));
    let key = '';
    for (let d = 0; d < width; d++) {
      key = (SORT_DIGITS[value % BASE] as string) + key;
      value = Math.floor(value / BASE);
    }
    return key.replace(/0+$/, '');
  });
}
