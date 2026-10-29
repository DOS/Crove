// Detective security alerts on PostgreSQL 17 (issue #996): one user acting in many orgs, a refusal spike and an owner
// or admin grant each alert once, then stay quiet until the repeat interval; a quiet deployment alerts nothing; the
// posted message holds ids and counts only. Who may read the signals is in test/invariant/security-signals.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { sweepSecuritySignals, type SecurityThresholds } from '../src/security-signals.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const THRESHOLDS: SecurityThresholds = { windowSeconds: 300, orgThreshold: 2, refusalThreshold: 50, repeatSeconds: 3600 };

suite('detective security alerts on PostgreSQL (#996)', () => {
  const dbName = `crove_test_secsig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  const orgs: string[] = [];
  let probe = '';
  const emails: string[] = [];

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const audit = (orgId: string, actorId: string, command: string, outcome: string, detail: Record<string, unknown> = {}, agoSeconds = 10) =>
    admin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, now() - make_interval(secs => $2), 'user', $3, $4, gen_random_uuid(), $5, repeat('0', 64), $6) RETURNING id`,
        [orgId, agoSeconds, actorId, command, outcome, JSON.stringify(detail)],
      );
      return rows[0]?.id ?? '';
    });

  // Every alert line and every posted message of one sweep.
  async function sweep() {
    const lines: string[] = [];
    const posted: Array<{ text: string; crove: Record<string, unknown> }> = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { text: string; crove: Record<string, unknown> };
      posted.push(body);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const found = await sweepSecuritySignals({
      workerDb,
      target: { webhookUrl: 'https://alerts.example.test/hook', webhookFormat: 'generic', telegramChatId: undefined, instance: 'books.example.test' },
      thresholds: THRESHOLDS,
      fetch,
      log: (line) => lines.push(line),
    });
    return { found, lines, posted };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 2 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    workerDb = createDb(workerPool);
    for (let i = 0; i < 3; i++) {
      const email = `owner${i}-${randomUUID().slice(0, 6)}@signals.test`;
      emails.push(email);
      const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email, name: `Owner ${i}` });
      orgs.push((await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, `Org ${i}`)).orgId);
    }
    const probeEmail = `probe-${randomUUID().slice(0, 6)}@signals.test`;
    emails.push(probeEmail);
    probe = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: probeEmail, name: 'Probe' });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('says nothing for a quiet deployment: the owners creating their orgs grant no role', async () => {
    expect(await sweep()).toEqual({ found: 0, lines: [], posted: [] });
  });

  it('alerts once when one user acts in more orgs than the threshold, and not for activity outside the window', async () => {
    const [a, b, c] = orgs as [string, string, string];
    await audit(a, probe, 'kernel.inbox.list', 'denied', { code: 'NOT_A_MEMBER' });
    await audit(b, probe, 'kernel.inbox.list', 'denied', { code: 'NOT_A_MEMBER' });
    // An hour ago: outside the 5-minute window.
    await audit(c, probe, 'kernel.inbox.list', 'denied', { code: 'NOT_A_MEMBER' }, 3600);
    expect((await sweep()).found).toBe(0);

    await audit(c, probe, 'kernel.inbox.list', 'denied', { code: 'NOT_A_MEMBER' });
    const first = await sweep();
    expect(first.found).toBe(1);
    expect(first.lines).toEqual([expect.stringMatching(new RegExp(`^\\[security\\] ALERT actor_many_orgs: user ${probe} acted in 3 orgs within 5 min`))]);
    expect(first.posted).toHaveLength(1);
    expect(first.posted[0]?.text).toMatch(/^\[Crove\] Security alert from books\.example\.test: user /);
    expect(first.posted[0]?.crove).toMatchObject({ kind: 'security', signal: 'actor_many_orgs', subject: probe, value: 3 });
    // The same signal stays quiet until the repeat interval.
    expect((await sweep()).found).toBe(0);
  });

  it('alerts once on a refusal spike across the deployment', async () => {
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.refusal_tally (org_id, window_start, actor_key, command, code, refusals, last_at)
         VALUES ($1, date_trunc('hour', now()), 'user:' || $2, 'kernel.inbox.list', 'FORBIDDEN', 60, now())`,
        [orgs[0], probe],
      ),
    );
    const spike = await sweep();
    expect(spike.found).toBe(1);
    expect(spike.posted[0]?.crove).toMatchObject({ signal: 'refusal_spike', subject: 'deployment', value: 60 });
    expect((await sweep()).found).toBe(0);
  });

  it('alerts once per owner or admin role given, and not for a member role', async () => {
    const [a] = orgs as [string];
    const member = await audit(a, probe, 'kernel.member.change_role', 'ok', { target_user: randomUUID(), role: 'member', previous_role: 'viewer' });
    const grant = await audit(a, probe, 'kernel.member.change_role', 'ok', { target_user: randomUUID(), role: 'admin', previous_role: 'member' });
    const joined = await audit(a, probe, 'kernel.member.invite.accept', 'ok', { target_user: probe, role: 'owner', previous_role: null });
    const unchanged = await audit(a, probe, 'kernel.member.change_role', 'ok', { target_user: randomUUID(), role: 'owner', previous_role: 'owner' });
    const refused = await audit(a, probe, 'kernel.member.change_role', 'denied', { target_user: randomUUID(), role: 'owner', previous_role: 'admin' });
    const found = await sweep();
    const subjects = found.posted.map((p) => p.crove.subject);
    expect(subjects.sort()).toEqual([grant, joined].sort());
    for (const id of [member, unchanged, refused]) expect(subjects).not.toContain(id);
    expect(found.lines.join('\n')).toContain(`admin role given in org ${a} (audit row ${grant})`);
    expect((await sweep()).found).toBe(0);

    // No email or name of anyone reached a log line or a message.
    const text = JSON.stringify(found) + JSON.stringify(await sweep());
    for (const email of emails) expect(text).not.toContain(email);
    expect(text).not.toMatch(/Owner \d|Probe/);
  });
});
