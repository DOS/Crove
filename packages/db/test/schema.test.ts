// The Kysely types in src/schema.ts over the generated ones (issues #48, #266). These are type-level checks: `pnpm
// typecheck` enforces them, including every @ts-expect-error line; the test run only executes the empty expectTypeOf
// calls and compiles (never runs) the queries below.
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type { Generated, Insertable, Selectable, Updateable } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as G from '../src/generated/database.ts';
import type { Database, MemberRole, Refine } from '../src/schema.ts';

describe('Database', () => {
  it('uses the refinements over the generated tables', () => {
    expectTypeOf<Selectable<Database['crove_kernel.tenant']>['status']>().toEqualTypeOf<'active' | 'offboarding' | 'closed'>();
    // A column crove_tenant may not write takes no value but undefined (G.NotGranted).
    expectTypeOf<Insertable<Database['crove_finance.journal_entry']>['created_xact_id']>().toEqualTypeOf<undefined>();
    // A refinement keeps that: tenant_member.role is refined to MemberRole, and crove_tenant may update but not insert it.
    expectTypeOf<Insertable<Database['crove_kernel.tenant_member']>['role']>().toEqualTypeOf<undefined>();
    expectTypeOf<Updateable<Database['crove_kernel.tenant_member']>['role']>().toEqualTypeOf<MemberRole | undefined>();
    // A refinement's never (accepted_at is written only by invite_accept()) becomes NotGranted as well.
    expectTypeOf<Insertable<Database['crove_kernel.member_invite']>['accepted_at']>().toEqualTypeOf<undefined>();
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

  // Write types follow crove_tenant's privileges (issue #266): a forbidden write does not compile.
  it('rejects writes crove_tenant may not make', () => {
    // outbox_event and the ledger: crove_tenant may not insert or update a row (definers write them).
    // @ts-expect-error outbox_event has no column crove_tenant may insert
    const outbox: Insertable<Database['crove_kernel.outbox_event']> = { org_id: 'o', type: 'x', payload: '{}' };
    // @ts-expect-error journal entries are written only by crove_finance.post_journal_entry()
    const entry: Insertable<Database['crove_finance.journal_entry']> = { org_id: 'o', entry_date: '2026-01-01', description: 'd', source_type: 's', source_id: 'i' };
    // Append-only tables: insert yes, update no.
    const audit: Insertable<Database['crove_kernel.audit_event']> = { org_id: 'o', actor_type: 'user', command: 'c', command_id: 'i', outcome: 'ok', input_sha256: 'h' };
    // @ts-expect-error audit_event is append-only
    const auditUpdate: Updateable<Database['crove_kernel.audit_event']> = { outcome: 'denied' };
    // Column grants: tenant_member is never inserted by crove_tenant and only its role is updated.
    // @ts-expect-error a member row is created by a definer, not inserted
    const member: Insertable<Database['crove_kernel.tenant_member']> = { org_id: 'o', user_id: 'u', role: 'member' };
    const roleChange: Updateable<Database['crove_kernel.tenant_member']> = { role: 'admin' };
    // @ts-expect-error user_id may not be updated
    const memberMove: Updateable<Database['crove_kernel.tenant_member']> = { user_id: 'u' };
    // @ts-expect-error an extraction keeps its file; only the result columns are updated
    const extraction: Updateable<Database['crove_kernel.extraction']> = { file_id: 'f' };
    // @ts-expect-error an invite's email is fixed; crove_tenant updates only status, revoked_at and revoked_by
    const invite: Updateable<Database['crove_kernel.member_invite']> = { email: 'a@b.c' };
    // A file row never changes (trigger file_guard): the refinement keeps the union and drops every update.
    expectTypeOf<Selectable<Database['crove_kernel.file']>['source']>().toEqualTypeOf<'upload' | 'email'>();
    // @ts-expect-error crove_tenant holds UPDATE on file only to lock the row
    const fileUpdate: Updateable<Database['crove_kernel.file']> = { filename: 'renamed.pdf' };
    expect([outbox, entry, audit, auditUpdate, member, roleChange, memberMove, extraction, invite, fileUpdate]).toHaveLength(10);
  });

  it('rejects them in the query builder too', () => {
    const db = new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const allowed = db.updateTable('crove_kernel.file_upload').set({ used_at: new Date(0) }).where('id', '=', 'x').compile();
    expect(allowed.sql).toContain('update "crove_kernel"."file_upload"');
    // @ts-expect-error a file upload is only ever marked used
    db.updateTable('crove_kernel.file_upload').set({ max_bytes: '1' }).compile();
    // @ts-expect-error outbox events are written by definers only
    db.insertInto('crove_kernel.outbox_event').values({ org_id: 'o', type: 'x', payload: '{}' }).compile();
    // @ts-expect-error purchase documents are append-only
    db.updateTable('crove_finance.purchase_document').set({ total: '1' }).compile();
  });
});
