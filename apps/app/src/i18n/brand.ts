// The product name users see (BRAND_NAME, issue #1040). Messages and guides say `{brand}` where they name the
// product; the catalogs handed to use-intl have it filled in, so no t() call passes it. The kernel serves the name in
// /api/config; main.tsx sets it once, before the first render, and "Ludy" stands until then (or when the server
// sends none). `{brandSlug}` is the same name as a file-name prefix ("ludy", "ten-moi"; #1045). `{assistant}` is the
// name the AI assistant goes by (#1683), whatever the brand.
import { brandSlug } from '@crove/kernel-contract';

export const DEFAULT_BRAND = 'Ludy';
export const ASSISTANT_NAME = 'Vy';

// The same rule as the kernel's BRAND_NAME: plain text, so it needs no escaping in HTML or an ICU message beyond the
// apostrophe. Anything else from the server is ignored rather than shown.
const BRAND_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&'+_!()-]*$/u;
const BRAND_MAX = 40;

let current = DEFAULT_BRAND;
const listeners = new Set<() => void>();

export function brandName(): string {
  return current;
}

// The configured name when it is valid, else "Ludy". Calls `subscribeBrand` listeners when it changes.
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

// Plain text (a guide line, a template sheet) with `{brand}`, `{brandSlug}` and `{assistant}` filled in.
export function withBrand(text: string, brand = current): string {
  return text.replaceAll('{brandSlug}', brandSlug(brand)).replaceAll('{brand}', brand).replaceAll('{assistant}', ASSISTANT_NAME);
}

// A downloaded file's name with the product name as its prefix: `crove-ke-hoach-2026-10.csv` under BRAND_NAME "Tên Mới"
// is saved as `ten-moi-ke-hoach-2026-10.csv`. Names the kernel or a module chose keep their `crove-` there (#1045).
export function brandFileName(name: string, brand = current): string {
  return name.startsWith('crove-') ? `${brandSlug(brand)}-${name.slice('crove-'.length)}` : name;
}

// The name as literal text inside an ICU message: an apostrophe is doubled, the only character of the allowed set
// that ICU treats specially.
function icuLiteral(brand: string): string {
  return brand.replaceAll("'", "''");
}

// `{brand}` and `{assistant}` replaced in every message of a catalog, at the type level too: use-intl then sees no
// `brand` or `assistant` argument, so callers pass none. "Ludy" stands in for the name in the types; only the arguments
// matter there.
type FillSlug<S extends string> = S extends `${infer Head}{brandSlug}${infer Tail}` ? `${Head}ludy${FillSlug<Tail>}` : S;
type FillBrand<S extends string> = S extends `${infer Head}{brand}${infer Tail}` ? `${Head}Ludy${FillBrand<Tail>}` : S;
type FillAssistant<S extends string> = S extends `${infer Head}{assistant}${infer Tail}` ? `${Head}Vy${FillAssistant<Tail>}` : S;
export type Branded<T> = { readonly [K in keyof T]: T[K] extends string ? FillAssistant<FillSlug<FillBrand<T[K]>>> : Branded<T[K]> };

export function brandCatalog<T extends object>(messages: T, brand: string): Branded<T> {
  const literal = icuLiteral(brand);
  const slug = brandSlug(brand);
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll('{brandSlug}', slug).replaceAll('{brand}', literal).replaceAll('{assistant}', ASSISTANT_NAME);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]));
    return value;
  };
  return fill(messages) as Branded<T>;
}
