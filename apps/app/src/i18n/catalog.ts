// Types that keep every catalog in step with the Vietnamese source (issue #215). vi.ts is declared `as const`, so
// use-intl checks the arguments of every t() call against the Vietnamese message; these types make the other
// catalogs have the same keys (`CatalogShape`) and, per message, the same ICU arguments and rich text tags with the
// same types (`ArgumentMismatches`), so a call that type-checks against Vietnamese formats in every locale.
import type { ICUArgs, ICUTags } from 'use-intl/core';

// The source catalog with every message widened to `string`: what another locale's catalog must satisfy.
export type CatalogShape<T> = { readonly [K in keyof T]: T[K] extends string ? string : CatalogShape<T[K]> };

// The values a message takes, as use-intl's t() and t.markup() type them.
type MessageArgs<M extends string> = ICUArgs<M, { ICUArgument: string; ICUNumberArgument: number | bigint; ICUDateArgument: Date }> &
  ICUTags<M, (chunks: string) => string>;

type Same<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

// The dotted keys whose message in `T` takes other arguments (names or types) or tags than in `S`; never when none.
export type ArgumentMismatches<S, T, Prefix extends string = ''> = {
  [K in keyof S & string]: K extends keyof T
    ? S[K] extends string
      ? T[K] extends string
        ? Same<MessageArgs<S[K]>, MessageArgs<T[K]>> extends true
          ? never
          : `${Prefix}${K}`
        : `${Prefix}${K}`
      : ArgumentMismatches<S[K], T[K], `${Prefix}${K}.`>
    : `${Prefix}${K}`;
}[keyof S & string];

// Fails the typecheck, naming the keys, unless `T` is never.
export type AssertNone<T extends never> = T;

// Checks of the types above, run by the typecheck: each mismatch below must be reported, and a plural in one
// language may stand for a number in another. Exported, and tagged @public for knip, so neither the linter nor knip
// reports them as unused.
/** @public */
// @ts-expect-error: an argument was renamed.
export type RenamedArgumentIsReported = AssertNone<ArgumentMismatches<{ a: 'x {n}' }, { a: 'y {m}' }>>;
/** @public */
// @ts-expect-error: a plain argument (a string) became a plural (a number).
export type RetypedArgumentIsReported = AssertNone<ArgumentMismatches<{ a: 'x {n}' }, { a: '{n, plural, other {#}}' }>>;
/** @public */
// @ts-expect-error: a rich text tag was dropped, in a nested group.
export type DroppedTagIsReported = AssertNone<ArgumentMismatches<{ g: { a: '<b>x</b>' } }, { g: { a: 'x' } }>>;
/** @public */
export type PluralForNumberIsAccepted = AssertNone<ArgumentMismatches<{ g: { a: '{n, number} x' } }, { g: { a: '{n, plural, other {# x}}' } }>>;
