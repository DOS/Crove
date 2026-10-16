// ctx.query keeps the access rules of Runtime.query() (plan Decision 12, ADR-0031, issue #199) on a real
// PostgreSQL 17: a lookup from a query or a command never reads what the caller could not read directly, a user
// never reaches a system query through it, and only a module the deployment leaves out answers not_installed (a
// misspelled module is QUERY_NOT_FOUND). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its
// own database. Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand, defineQuery, type Lookup } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

// The targets: one every member may read, one only owners and admins may read, one only the system actor may read.
const anyMember = defineQuery({
  name: 'probe.any_member',
  input: z.object({}),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async () => 'open',
});
const adminOnly = defineQuery({
  name: 'probe.admin_only',
  input: z.object({}),
  access: ['owner', 'admin'],
  handler: async () => 'secret',
});
const systemOnly = defineQuery({
  name: 'probe.system_only',
  input: z.object({}),
  access: 'system',
  handler: async () => 'system',
});
// The callers: every member may run them, and each looks up the query it is given.
const viaQuery = defineQuery({
  name: 'probe.via_query',
  input: z.object({ name: z.string() }),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: (ctx, input) => ctx.query<string>(input.name, {}),
});
const viaCommand = defineCommand({
  name: 'probe.via_command',
  input: z.object({ name: z.string() }),
  risk: 'R1',
  access: ['owner', 'admin', 'member'],
  handler: (ctx, input) => ctx.query<string>(input.name, {}),
});

const suite = ADMIN ? describe : describe.skip;

suite('ctx.query access (ADR-0031, #199)', () => {
  const dbName = `crove_test_ctx_query_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let orgId = '';
  const users = { owner: '', member: '', viewer: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 2 });
    db = createDb(pool);
    // finance is a module the deployment ships but leaves out here.
    runtime = new Runtime(db, { absentModules: ['finance'] }).register({
      commands: [...kernelCommands, viaCommand],
      queries: [...kernelQueries({ inboundDomain: null }), anyMember, adminOnly, systemOnly, viaQuery],
    });
    users.owner = await upsertIdentity(db, { issuer: 'test', subject: 'cq-owner', email: 'owner@cq.test', name: null });
    users.member = await upsertIdentity(db, { issuer: 'test', subject: 'cq-member', email: 'member@cq.test', name: null });
    users.viewer = await upsertIdentity(db, { issuer: 'test', subject: 'cq-viewer', email: 'viewer@cq.test', name: null });
    orgId = (await createOrg(runtime, asUser(users.owner), 'Ctx Query')).orgId;
    const seed = new pg.Client({ connectionString: adminUrl });
    await seed.connect();
    await seed.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`, [
      orgId,
      users.member,
      users.viewer,
    ]);
    await seed.end();
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  const lookupFromQuery = (userId: string, name: string) =>
    runtime.query<Lookup<string>>('probe.via_query', { name }, { actor: asUser(userId), orgId });
  const lookupFromCommand = (userId: string, name: string) =>
    runtime.execute<Lookup<string>>('probe.via_command', { name }, { actor: asUser(userId), orgId });

  it('lets a role read through ctx.query only what it may read directly', async () => {
    // Controls: the callers themselves are allowed, so each FORBIDDEN below comes from the lookup.
    expect(await lookupFromQuery(users.viewer, 'probe.any_member')).toEqual({ status: 'ok', value: 'open' });
    expect(await lookupFromQuery(users.member, 'probe.any_member')).toEqual({ status: 'ok', value: 'open' });
    expect(await lookupFromCommand(users.member, 'probe.any_member')).toEqual({ status: 'ok', value: 'open' });
    expect(await lookupFromQuery(users.owner, 'probe.admin_only')).toEqual({ status: 'ok', value: 'secret' });
    await expect(runtime.query('probe.admin_only', {}, { actor: asUser(users.viewer), orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(lookupFromQuery(users.viewer, 'probe.admin_only')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(lookupFromQuery(users.member, 'probe.admin_only')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    // From a command, in its writable transaction, the same check applies.
    await expect(lookupFromCommand(users.member, 'probe.admin_only')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await lookupFromCommand(users.owner, 'probe.admin_only')).toEqual({ status: 'ok', value: 'secret' });
  });

  it('never lets a user reach a system query through ctx.query', async () => {
    await expect(lookupFromQuery(users.owner, 'probe.system_only')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(lookupFromCommand(users.owner, 'probe.system_only')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('answers not_installed only for a module the deployment leaves out', async () => {
    expect(await lookupFromQuery(users.owner, 'finance.accounts.list')).toEqual({ status: 'not_installed', module: 'finance' });
    // A misspelled module, and an unknown query of an installed module, are caller bugs.
    await expect(lookupFromQuery(users.owner, 'finanse.accounts.list')).rejects.toMatchObject({ code: 'QUERY_NOT_FOUND', status: 404 });
    await expect(lookupFromQuery(users.owner, 'kernel.no_such_query')).rejects.toMatchObject({ code: 'QUERY_NOT_FOUND', status: 404 });
    await expect(lookupFromCommand(users.owner, 'finanse.accounts.list')).rejects.toMatchObject({ code: 'QUERY_NOT_FOUND', status: 404 });
  });
});
