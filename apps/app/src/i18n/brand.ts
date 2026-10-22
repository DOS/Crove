// The product name users see (BRAND_NAME, issue #1040). Messages and guides say `{brand}` where they name the
// product; the catalogs handed to use-intl have it filled in, so no t() call passes it. The kernel serves the name in
// /api/config; main.tsx sets it once, before the first render, and "Crove" stands until then (or when the server
// sends none).

export const DEFAULT_BRAND = 'Crove';

// The same rule as the kernel's BRAND_NAME: plain text, so it needs no escaping in HTML or an ICU message beyond the
// apostrophe. Anything else from the server is ignored rather than shown.
const BRAND_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&'+_!()-]*$/u;
const BRAND_MAX = 40;

let current = DEFAULT_BRAND;
const listeners = new Set<() => void>();

export function brandName(): string {
  return current;
}

// The configured name when it is valid, else "Crove". Calls `subscribeBrand` listeners when it changes.
export function setBrandName(name: unknown): void {
  const next = typeof name === 'string' && name.trim().length <= BRAND_MAX && BRAND_PATTERN.test(name.trim()) ? name.trim() : DEFAULT_BRAND;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeBrand(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Plain text (a guide line, a template sheet) with `{brand}` filled in.
export function withBrand(text: string, brand = current): string {
  return text.replaceAll('{brand}', brand);
}

// The name as literal text inside an ICU message: an apostrophe is doubled, the only character of the allowed set
// that ICU treats specially.
function icuLiteral(brand: string): string {
  return brand.replaceAll("'", "''");
}

// `{brand}` replaced in every message of a catalog, at the type level too: use-intl then sees no `brand` argument, so
// callers pass none. "Crove" stands in for the name in the types; only the arguments matter there.
type FillBrand<S extends string> = S extends `${infer Head}{brand}${infer Tail}` ? `${Head}Crove${FillBrand<Tail>}` : S;
export type Branded<T> = { readonly [K in keyof T]: T[K] extends string ? FillBrand<T[K]> : Branded<T[K]> };

export function brandCatalog<T extends object>(messages: T, brand: string): Branded<T> {
  const literal = icuLiteral(brand);
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll('{brand}', literal);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]));
    return value;
  };
  return fill(messages) as Branded<T>;
}
