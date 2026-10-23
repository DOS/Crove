// Invariant suite (Decision 7): DDL outside the migration pipeline is recorded and alerted (issue #1202, plan §7.8
// "Detective controls"). The event triggers that `migrate` installs record every schema change except the pipeline's
// own, which marks its session in crove_meta.pipeline_session; no login role can write that mark or the records, and
// the worker alerts each session's changes once through the security signals. Keep this directory self-contained:
// import package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run creates and drops its own database and role.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { installDdlWatch, migrate, setRolePasswords } from '@crove/db/migrate';
import { sweepSecuritySignals } from '../../src/security-signals.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];

const suite = ADMIN ? describe : describe.skip;

interface DdlRow {
  session_role: string;
  set_role: string | null;
  command_tag: string;
  object_type: string | null;
  object_identity: string | null;
}

suite('DDL outside the migration pipeline on PostgreSQL (#1202)', () => {
  const runId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dbName = `crove_test_ddlwatch_${runId}`;
  // Roles are cluster-wide: this run's own, dropped at the end.
  const probeRole = `t1202_ddl_probe_${runId}`;
  let adminUrl = '';
  let adminRole = '';
  let appUrl = '';
  let workerUrl = '';
  let workerPool: pg.Pool | undefined;
  let workerDb: Db;
  let extraDir = '';

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const records = () =>
    withClient(adminUrl, async (c) => {
      const { rows } = await c.query<DdlRow>(
        'SELECT session_role, set_role, command_tag, object_type, object_identity FROM crove_kernel.ddl_event ORDER BY id',
      );
      return rows;
    });

  async function sweep() {
    const lines: string[] = [];
    const posted: Array<{ text: string; crove: Record<string, unknown> }> = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)) as { text: string; crove: Record<string, unknown> });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const found = await sweepSecuritySignals({
      workerDb,
      target: { webhookUrl: 'https://alerts.example.test/hook', webhookFormat: 'generic', telegramChatId: undefined, instance: 'books.example.test' },
      fetch,
      log: (line) => lines.push(line),
    });
    return { found, lines, posted: posted.filter((p) => p.crove.signal === 'out_of_pipeline_ddl') };
  }

  beforeAll(async () => {
    await withClient(ADMIN as string, (root) => root.query(`CREATE DATABASE ${dbName}`));
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    adminRole = decodeURIComponent(base.username);
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    workerDb = createDb(workerPool);
    // Every migration plus one more that changes the schema, applied by the runner after the watch is installed.
    extraDir = mkdtempSync(join(tmpdir(), 'crove-ddlwatch-'));
    cpSync(MIGRATIONS, extraDir, { recursive: true });
    writeFileSync(
      join(extraDir, '29991231000000_crove_kernel_ddl_watch_probe.sql'),
      `CREATE TABLE IF NOT EXISTS crove_kernel.ddl_watch_probe (id integer PRIMARY KEY);
       COMMENT ON TABLE crove_kernel.ddl_watch_probe IS 'applied by the runner';
       DROP TABLE crove_kernel.ddl_watch_probe;\n`,
    );
  });

  afterAll(async () => {
    await workerPool?.end();
    if (extraDir) rmSync(extraDir, { recursive: true, force: true });
    if (!ADMIN) return;
    await withClient(ADMIN, async (root) => {
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await root.query(`DROP ROLE IF EXISTS ${probeRole}`);
    });
  });

  it('installs both event triggers, enabled for every session, and installs them again in place', async () => {
    expect(await installDdlWatch({ adminUrl })).toBe('installed');
    expect(await installDdlWatch({ adminUrl })).toBe('installed');
    const triggers = await withClient(adminUrl, async (c) => {
      const { rows } = await c.query<{ evtname: string; evtevent: string; evtenabled: string; fn: string }>(
        `SELECT evtname, evtevent, evtenabled, evtfoid::regprocedure::text AS fn FROM pg_event_trigger ORDER BY evtname`,
      );
      return rows;
    });
    expect(triggers).toEqual([
      { evtname: 'crove_ddl_watch', evtevent: 'ddl_command_end', evtenabled: 'A', fn: 'crove_kernel.ddl_watch()' },
      { evtname: 'crove_ddl_watch_drop', evtevent: 'sql_drop', evtenabled: 'A', fn: 'crove_kernel.ddl_watch()' },
    ]);
    expect(await records()).toEqual([]);
  });

  it('records nothing the migration runner does, and leaves no mark behind', async () => {
    const applied = await migrate({ adminUrl, dir: extraDir });
    expect(applied).toEqual(['29991231000000_crove_kernel_ddl_watch_probe.sql']);
    expect(await records()).toEqual([]);
    const marks = await withClient(adminUrl, (c) => c.query('SELECT * FROM crove_meta.pipeline_session'));
    expect(marks.rows).toEqual([]);
  });

  it('records DDL by the database owner outside the runner, and the worker alerts it once per session', async () => {
    await withClient(adminUrl, async (c) => {
      await c.query('CREATE TABLE public.ddl_probe (id integer)');
      await c.query(`COMMENT ON TABLE public.ddl_probe IS 'by hand'`);
      await c.query('CREATE INDEX ddl_probe_seen_idx ON crove_kernel.security_signal_seen (subject)');
      await c.query('ALTER TABLE crove_kernel.audit_event DISABLE TRIGGER USER');
      await c.query('ALTER TABLE crove_kernel.audit_event ENABLE TRIGGER USER');
      await c.query('DROP INDEX crove_kernel.ddl_probe_seen_idx');
      await c.query('DROP TABLE public.ddl_probe');
      // A row a crashed run left behind (this pid, another start time) does not pass the session off as the runner's.
      await c.query(`INSERT INTO crove_meta.pipeline_session (pid, backend_start, step) VALUES (pg_backend_pid(), '2000-01-01', 'migrate')`);
      await c.query('CREATE TABLE public.ddl_probe_after_mark (id integer)');
      await c.query('DROP TABLE public.ddl_probe_after_mark');
    });
    const owner = (command_tag: string, object_type: string, object_identity: string): DdlRow => ({
      session_role: adminRole,
      set_role: null,
      command_tag,
      object_type,
      object_identity,
    });
    expect(await records()).toEqual([
      owner('CREATE TABLE', 'table', 'public.ddl_probe'),
      owner('COMMENT', 'table', 'public.ddl_probe'),
      owner('CREATE INDEX', 'index', 'crove_kernel.ddl_probe_seen_idx'),
      owner('ALTER TABLE', 'table', 'crove_kernel.audit_event'),
      owner('ALTER TABLE', 'table', 'crove_kernel.audit_event'),
      owner('DROP INDEX', 'index', 'crove_kernel.ddl_probe_seen_idx'),
      owner('DROP TABLE', 'table', 'public.ddl_probe'),
      owner('CREATE TABLE', 'table', 'public.ddl_probe_after_mark'),
      owner('DROP TABLE', 'table', 'public.ddl_probe_after_mark'),
    ]);

    const first = await sweep();
    expect(first.posted).toHaveLength(1);
    expect(first.posted[0]?.crove).toMatchObject({ kind: 'security', signal: 'out_of_pipeline_ddl', value: 9, orgId: null });
    expect(first.posted[0]?.text).toMatch(
      new RegExp(`^\\[Crove\\] Security alert from books\\.example\\.test: 9 schema change\\(s\\) outside the migration pipeline, first by ${adminRole}: CREATE TABLE public\\.ddl_probe \\(ddl_event \\d+\\)`),
    );
    expect(first.lines.filter((l) => l.startsWith('[security] ALERT out_of_pipeline_ddl:'))).toHaveLength(1);
    // Alerted once: the next pass is quiet, and every record carries its alert time.
    expect((await sweep()).posted).toEqual([]);
    const pending = await withClient(adminUrl, (c) => c.query('SELECT count(*)::int AS n FROM crove_kernel.ddl_event WHERE alerted_at IS NULL'));
    expect(pending.rows).toEqual([{ n: 0 }]);
  });

  it('records a role that may create objects but not mark its session, with the role it switched to', async () => {
    await withClient(adminUrl, async (c) => {
      await c.query(`CREATE ROLE ${probeRole} NOLOGIN`);
      await c.query(`GRANT CREATE ON SCHEMA public TO ${probeRole}`);
      await c.query(`SET SESSION AUTHORIZATION ${probeRole}`);
      await expect(
        c.query(`INSERT INTO crove_meta.pipeline_session (pid, backend_start, step) SELECT pid, backend_start, 'migrate' FROM pg_stat_activity WHERE pid = pg_backend_pid()`),
      ).rejects.toThrow(/permission denied for schema crove_meta/);
      await c.query('CREATE TABLE public.ddl_probe_role (id integer)');
      await c.query('DROP TABLE public.ddl_probe_role');
      await c.query('RESET SESSION AUTHORIZATION');
      // The owner switching role is recorded under its session role, with the role it switched to.
      await c.query(`SET ROLE ${probeRole}`);
      await c.query('CREATE TABLE public.ddl_probe_set_role (id integer)');
      await c.query('RESET ROLE');
      await c.query('DROP TABLE public.ddl_probe_set_role');
      await c.query(`REVOKE CREATE ON SCHEMA public FROM ${probeRole}`);
    });
    const rows = (await records()).slice(-5);
    expect(rows).toEqual([
      { session_role: probeRole, set_role: null, command_tag: 'CREATE TABLE', object_type: 'table', object_identity: 'public.ddl_probe_role' },
      { session_role: probeRole, set_role: null, command_tag: 'DROP TABLE', object_type: 'table', object_identity: 'public.ddl_probe_role' },
      { session_role: adminRole, set_role: probeRole, command_tag: 'CREATE TABLE', object_type: 'table', object_identity: 'public.ddl_probe_set_role' },
      { session_role: adminRole, set_role: null, command_tag: 'DROP TABLE', object_type: 'table', object_identity: 'public.ddl_probe_set_role' },
      { session_role: adminRole, set_role: null, command_tag: 'REVOKE', object_type: 'SCHEMA', object_identity: null },
    ]);
    // One database session (the grant before the switch included): one alert.
    const { posted } = await sweep();
    expect(posted.map((p) => p.crove.value)).toEqual([6]);
  });

  it('keeps the records and the mark out of every login role, behind a pinned definer no role may execute', async () => {
    const { shape, tables } = await withClient(adminUrl, async (c) => {
      const { rows: defs } = await c.query<{ definer: boolean; config: string[]; grantees: number }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config,
                (SELECT count(*)::int FROM unnest($1::text[]) r WHERE has_function_privilege(r, p.oid, 'EXECUTE')) AS grantees
         FROM pg_proc p WHERE p.oid = 'crove_kernel.ddl_watch()'::regprocedure`,
        [ROLES],
      );
      const { rows: grants } = await c.query<{ name: string; rls: boolean; grantees: number }>(
        `SELECT c.oid::regclass::text AS name, c.relrowsecurity AS rls,
                (SELECT count(*)::int FROM unnest($1::text[]) r WHERE has_table_privilege(r, c.oid, 'SELECT') OR has_table_privilege(r, c.oid, 'INSERT')
                   OR has_table_privilege(r, c.oid, 'UPDATE') OR has_table_privilege(r, c.oid, 'DELETE')) AS grantees
         FROM pg_class c WHERE c.oid IN ('crove_kernel.ddl_event'::regclass, 'crove_meta.pipeline_session'::regclass) ORDER BY 1`,
        [ROLES],
      );
      return { shape: defs, tables: grants };
    });
    expect(shape).toEqual([{ definer: true, config: ['search_path=pg_catalog, pg_temp'], grantees: 0 }]);
    expect(tables).toEqual([
      { name: 'crove_kernel.ddl_event', rls: true, grantees: 0 },
      { name: 'crove_meta.pipeline_session', rls: false, grantees: 0 },
    ]);
    for (const url of [appUrl, workerUrl]) {
      await expect(withClient(url, (c) => c.query('SELECT * FROM crove_kernel.ddl_event'))).rejects.toThrow(/permission denied for table ddl_event/);
      await expect(withClient(url, (c) => c.query(`INSERT INTO crove_kernel.ddl_event (session_role, command_tag, backend_pid) VALUES ('x', 'x', 1)`))).rejects.toThrow(
        /permission denied for table ddl_event/,
      );
      await expect(withClient(url, (c) => c.query('UPDATE crove_kernel.ddl_event SET alerted_at = now()'))).rejects.toThrow(/permission denied for table ddl_event/);
      await expect(
        withClient(url, (c) => c.query(`INSERT INTO crove_meta.pipeline_session (pid, backend_start, step) VALUES (pg_backend_pid(), now(), 'migrate')`)),
      ).rejects.toThrow(/permission denied for (table pipeline_session|schema crove_meta)/);
    }
  });
});
