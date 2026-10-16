// The Kysely types in src/schema.ts over the generated ones (issue #48). These are type-level checks: `pnpm typecheck`
// enforces them, including every @ts-expect-error line; the test run only executes the empty expectTypeOf calls.
import type { Generated, Insertable, Selectable } from 'kysely';
import { describe, expectTypeOf, it } from 'vitest';
import type * as G from '../src/generated/database.ts';
import type { Database, Refine } from '../src/schema.ts';

describe('Database', () => {
  it('uses the refinements over the generated tables', () => {
    expectTypeOf<Selectable<Database['crove_kernel.tenant']>['status']>().toEqualTypeOf<'active' | 'offboarding' | 'closed'>();
    expectTypeOf<Insertable<Database['crove_finance.journal_entry']>>().not.toHaveProperty('created_xact_id');
    // A table without a refinement is the generated type as is.
    expectTypeOf<Database['crove_kernel.idempotency_key']>().toEqualTypeOf<G.KernelIdempotencyKeyTable>();
  });

  it('has no control-plane or definer-only table', () => {
    type ControlPlane = 'user_account' | 'auth_session' | 'inbound_address' | 'inbound_pending' | 'auth_email_send';
    // Tables crove_tenant cannot read: only definers or the worker reach them.
    type DefinerOnly =
      | 'credential'
      | 'context_key'
      | 'auth_session_org'
      | 'inbound_drop'
      | 'outbox_pending'
      | 'refusal_tally'
      | 'worker_heartbeat';
    expectTypeOf<Extract<keyof Database, `crove_kernel.${ControlPlane | DefinerOnly}`>>().toBeNever();
    expectTypeOf<Extract<keyof G.Database, `crove_kernel.${ControlPlane | DefinerOnly}`>>().toBeNever();
  });

  it('refinements cannot contradict the database', () => {
    expectTypeOf<Refine<G.KernelPartyTable, { tax_code: string | null }>>().not.toBeNever();
    // @ts-expect-error not a column of the generated table
    expectTypeOf<Refine<G.KernelTenantTable, { no_such_column: string }>>().not.toBeNever();
    // @ts-expect-error the column is nullable in the database
    expectTypeOf<Refine<G.KernelPartyTable, { tax_code: string }>>().not.toBeNever();
    // @ts-expect-error the select type does not fit the database column
    expectTypeOf<Refine<G.KernelTenantTable, { name: number }>>().not.toBeNever();
    // @ts-expect-error a non-null column refined as nullable
    expectTypeOf<Refine<G.KernelTenantTable, { name: string | null }>>().not.toBeNever();
    // @ts-expect-error the column has no default in the database
    expectTypeOf<Refine<G.KernelTenantTable, { name: Generated<string> }>>().not.toBeNever();
    // A column a trigger assigns may be optional on insert when it is listed as such.
    expectTypeOf<Refine<G.KernelExtractionTable, { version: Generated<number> }, 'version'>>().not.toBeNever();
    // @ts-expect-error without the listing it may not
    expectTypeOf<Refine<G.KernelExtractionTable, { version: Generated<number> }>>().not.toBeNever();
  });
});
