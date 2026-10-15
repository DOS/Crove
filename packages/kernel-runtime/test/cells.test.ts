// Cell-ready pool resolution (Decision 14, plan §3.6): every tenant transaction opens on the database that the
// resolver returns for its org, and every org-less path opens on the control plane. Two fake databases record
// the SQL each one receives, so a path that opens on the wrong one shows up here without PostgreSQL.
import { describe, expect, it, vi } from 'vitest';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { z } from 'zod';
import { singleCell, type CellResolver, type Database, type Db } from '@crove/db';
import { Runtime, defineCommand, defineQuery, type UserActor } from '../src/runtime.ts';

const ORG = '01900000-0000-7000-8000-000000000001';
const NEW_ORG = '01900000-0000-7000-8000-000000000002';
const USER: UserActor = { type: 'user', userId: '01900000-0000-7000-8000-0000000000aa', aal: 'aal1' };

// A database that records each statement and answers enter_context with `role`, everything else with no rows.
function fakeDb(role: string) {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
      const rows = query.sql.includes('crove_kernel.enter_context(') ? [{ role }] : [];
      return { rows: rows as R[] };
    },
    // oxlint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {
      statements.push('BEGIN');
    },
    commitTransaction: async () => {
      statements.push('COMMIT');
    },
    rollbackTransaction: async () => {
      statements.push('ROLLBACK');
    },
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const db: Db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

function cells(role = 'owner') {
  const tenant = fakeDb(role);
  const control = fakeDb(role);
  const resolver: CellResolver = {
    resolveTenant: vi.fn(async () => tenant.db),
    controlPlane: vi.fn(() => control.db),
  };
  return { resolver, tenant: tenant.statements, control: control.statements };
}

const ownerCommand = defineCommand({
  name: 'test.touch',
  input: z.object({}),
  risk: 'R1',
  access: ['owner'],
  handler: async () => 'done',
});

const createOrg = defineCommand({
  name: 'test.create_org',
  input: z.object({}),
  risk: 'R1',
  access: ['owner'],
  bootstrap: async () => NEW_ORG,
  handler: async () => 'created',
});

const ownerQuery = defineQuery({
  name: 'test.read',
  input: z.object({}),
  access: ['owner'],
  handler: async () => 'read',
});

function runtimeOn(resolver: CellResolver | Db) {
  return new Runtime(resolver).register({ commands: [ownerCommand, createOrg], queries: [ownerQuery] });
}

describe('cell resolution', () => {
  it('runs a command on the org cell', async () => {
    const { resolver, tenant, control } = cells();
    await expect(runtimeOn(resolver).execute('test.touch', {}, { actor: USER, orgId: ORG })).resolves.toBe('done');
    expect(resolver.resolveTenant).toHaveBeenCalledTimes(1);
    expect(resolver.resolveTenant).toHaveBeenCalledWith(ORG);
    expect(resolver.controlPlane).not.toHaveBeenCalled();
    expect(tenant.some((s) => s.includes('enter_context'))).toBe(true);
    expect(tenant.some((s) => s.includes('audit_event'))).toBe(true);
    expect(control).toEqual([]);
  });

  it('runs a command with an idempotency key on the org cell', async () => {
    const { resolver, tenant, control } = cells();
    // The fake claims nothing, so the replay lookup finds no row and the command is refused as a mismatch.
    await expect(runtimeOn(resolver).execute('test.touch', {}, { actor: USER, orgId: ORG, idempotencyKey: 'k1' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
    });
    expect(tenant.some((s) => s.includes('idempotency_key'))).toBe(true);
    expect(resolver.controlPlane).not.toHaveBeenCalled();
    expect(control).toEqual([]);
  });

  it('writes the refusal audit of a refused command on the org cell', async () => {
    const { resolver, tenant, control } = cells('viewer');
    await expect(runtimeOn(resolver).execute('test.touch', {}, { actor: USER, orgId: ORG })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Once for the command, once for the refusal audit's own transaction.
    expect(resolver.resolveTenant).toHaveBeenCalledTimes(2);
    expect(resolver.resolveTenant).toHaveBeenNthCalledWith(1, ORG);
    expect(resolver.resolveTenant).toHaveBeenNthCalledWith(2, ORG);
    expect(tenant.filter((s) => s === 'BEGIN')).toHaveLength(2);
    expect(tenant.some((s) => s.includes('audit_event'))).toBe(true);
    expect(resolver.controlPlane).not.toHaveBeenCalled();
    expect(control).toEqual([]);
  });

  it('runs a query on the org cell', async () => {
    const { resolver, tenant, control } = cells();
    await expect(runtimeOn(resolver).query('test.read', {}, { actor: USER, orgId: ORG })).resolves.toBe('read');
    expect(resolver.resolveTenant).toHaveBeenCalledWith(ORG);
    expect(resolver.controlPlane).not.toHaveBeenCalled();
    expect(tenant.some((s) => s.includes('READ ONLY'))).toBe(true);
    expect(control).toEqual([]);
  });

  it('runs an org-less command on the control plane', async () => {
    const { resolver, tenant, control } = cells();
    await expect(runtimeOn(resolver).executeOrgless('test.create_org', {}, { actor: USER })).resolves.toBe('created');
    expect(resolver.controlPlane).toHaveBeenCalledTimes(1);
    expect(resolver.resolveTenant).not.toHaveBeenCalled();
    expect(control.some((s) => s.includes('enter_context'))).toBe(true);
    expect(tenant).toEqual([]);
  });

  it('runs signed-in user reads on the control plane', async () => {
    const { resolver, tenant, control } = cells();
    await runtimeOn(resolver).forUser(USER, (db) => sql`SELECT crove_kernel.my_orgs(${USER.userId}::uuid)`.execute(db));
    expect(resolver.controlPlane).toHaveBeenCalledTimes(1);
    expect(resolver.resolveTenant).not.toHaveBeenCalled();
    expect(control.some((s) => s.includes('my_orgs'))).toBe(true);
    expect(tenant).toEqual([]);
  });

  it('runs org-less machinery on the control plane', async () => {
    const { resolver, tenant, control } = cells();
    await runtimeOn(resolver).orgless((db) => sql`SELECT crove_kernel.org_by_inbound_token(${'t'})`.execute(db));
    expect(resolver.controlPlane).toHaveBeenCalledTimes(1);
    expect(resolver.resolveTenant).not.toHaveBeenCalled();
    expect(control.some((s) => s.includes('org_by_inbound_token'))).toBe(true);
    expect(tenant).toEqual([]);
  });

  it('treats a plain Db as a single cell', async () => {
    const one = fakeDb('owner');
    const runtime = runtimeOn(one.db);
    await runtime.execute('test.touch', {}, { actor: USER, orgId: ORG });
    await runtime.forUser(USER, async () => null);
    expect(one.statements.filter((s) => s === 'BEGIN')).toHaveLength(2);
  });

  it('singleCell returns the same database for every org and the control plane', async () => {
    const { db } = fakeDb('owner');
    const single = singleCell(db);
    expect(await single.resolveTenant(ORG)).toBe(db);
    expect(await single.resolveTenant(NEW_ORG)).toBe(db);
    expect(single.controlPlane()).toBe(db);
  });
});
