// The org's audit log for owners and admins on PostgreSQL 17 (issue #672): who may read it, the filters, the pages, the
// org boundary, what a row's detail shows, and the CSV export with its own audit row. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { AUDIT_CSV_HEAD, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { AUDIT_EXPORT_LIMIT, AUDIT_PAGE_SIZE, type AuditEntry, type AuditExport, type AuditFilter, type AuditPage } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('audit log for owners and admins on PostgreSQL (#672)', () => {
  const dbName = `crove_test_audit_log_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function person(name: string, displayName: string | null = null) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@audit.test`, name: displayName });
  }

  async function org(ownerName: string | null = null) {
    const owner = await person('owner', ownerName);
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles: Record<'admin' | 'member' | 'viewer', string> = { admin: await person('admin', 'Quản trị'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...roles };
  }

  interface Seed {
    at: string;
    actorType?: 'user' | 'system';
    actorId?: string | null;
    command: string;
    outcome?: string;
    targetType?: string | null;
    targetId?: string | null;
    proposalId?: string | null;
    detail?: unknown;
  }

  async function seed(orgId: string, rows: Seed[]): Promise<string[]> {
    const ids: string[] = [];
    for (const r of rows) {
      const id = randomUUID();
      ids.push(id);
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, id, occurred_at, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, proposal_id, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [orgId, id, r.at, r.actorType ?? 'user', r.actorId ?? null, r.command, randomUUID(), r.outcome ?? 'ok', r.targetType ?? null, r.targetId ?? null, 'a'.repeat(64), r.proposalId ?? null, JSON.stringify(r.detail ?? {})],
        ),
      );
    }
    return ids;
  }

  const list = (o: { orgId: string }, user: string, filter: AuditFilter & { before?: { at: string; id: string } } = {}) =>
    rt.query<AuditPage>('kernel.audit.list', filter, { actor: asUser(user), orgId: o.orgId });
  // The seeded rows are dated 1 to 5 October 2026; the rows the test's own commands write (org creation and so on) carry
  // the clock's time, so these days keep them out.
  const SEEDED: AuditFilter = { from: '2026-09-01', to: '2026-10-10' };
  const seeded = (o: { orgId: string }, user: string, filter: AuditFilter = {}) => list(o, user, { ...SEEDED, ...filter }).then((p) => p.items);

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
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is for owners and admins only, and lists what a command did with who did it', async () => {
    const o = await org();
    await rt.execute('kernel.org.set_address', { address: '1 Lê Lợi, Quận 1' }, { actor: asUser(o.admin), orgId: o.orgId });
    const page = await list(o, o.owner, { command: 'kernel.org.set_address' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ actorType: 'user', actorId: o.admin, actorName: 'Quản trị', command: 'kernel.org.set_address', outcome: 'ok' });
    expect((await list(o, o.admin)).items.length).toBeGreaterThan(0);
    for (const who of [o.member, o.viewer]) {
      await expect(list(o, who)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      await expect(rt.query('kernel.audit.commands', {}, { actor: asUser(who), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
      await expect(rt.execute('kernel.audit.export', {}, { actor: asUser(who), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    }
    // A former member keeps their rows, without a name.
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.admin]));
    expect((await list(o, o.owner, { command: 'kernel.org.set_address' })).items[0]).toMatchObject({ actorId: o.admin, actorName: null });
  });

  it('filters by actor, command, outcome, object and days in Vietnam time', async () => {
    const o = await org();
    const proposal = randomUUID();
    const doc = randomUUID();
    const [a, b, c, d] = await seed(o.orgId, [
      { at: '2026-10-01T03:00:00Z', actorId: o.owner, command: 'kernel.proposal.approve', targetType: 'kernel.proposal', targetId: proposal, proposalId: proposal },
      // 00:30 on 2 October in Vietnam.
      { at: '2026-10-01T17:30:00Z', actorType: 'system', command: 'finance.purchase.record', proposalId: proposal, targetType: 'finance.purchase_document', targetId: doc },
      { at: '2026-10-03T03:00:00Z', actorId: o.admin, command: 'finance.journal.export', outcome: 'denied' },
      { at: '2026-10-04T03:00:00Z', actorId: o.admin, command: 'kernelx.other' },
    ]);
    const ids = (items: AuditEntry[]) => items.map((i) => i.id);
    expect(ids(await seeded(o, o.owner))).toEqual([d, c, b, a]);
    expect(ids(await seeded(o, o.owner, { actor: o.admin }))).toEqual([d, c]);
    expect(ids(await seeded(o, o.owner, { actor: 'system' }))).toEqual([b]);
    expect(ids(await seeded(o, o.owner, { command: 'finance.' }))).toEqual([c, b]);
    expect(ids(await seeded(o, o.owner, { command: 'kernel.' }))).toEqual([a]);
    expect(ids(await seeded(o, o.owner, { command: 'finance.journal.export' }))).toEqual([c]);
    expect(ids(await seeded(o, o.owner, { outcome: 'denied' }))).toEqual([c]);
    // An object's id finds the rows that targeted it and the rows of its proposal.
    expect(ids(await seeded(o, o.owner, { targetId: proposal }))).toEqual([b, a]);
    expect(ids(await seeded(o, o.owner, { targetId: doc }))).toEqual([b]);
    expect(ids(await seeded(o, o.owner, { targetType: 'kernel.proposal' }))).toEqual([a]);
    expect(ids(await seeded(o, o.owner, { from: '2026-10-02', to: '2026-10-03' }))).toEqual([c, b]);
    expect(ids(await seeded(o, o.owner, { from: '2026-10-01', to: '2026-10-01' }))).toEqual([a]);
    await expect(list(o, o.owner, { from: '2026-10-03', to: '2026-10-01' })).rejects.toMatchObject({ code: 'AUDIT_RANGE', status: 422 });
    const commands = await rt.query<string[]>('kernel.audit.commands', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(commands).toEqual(expect.arrayContaining(['finance.journal.export', 'finance.purchase.record', 'kernel.proposal.approve', 'kernelx.other']));
    expect(commands).toEqual([...commands].sort());
  });

  it('pages newest first without gaps or repeats, and never shows another org', async () => {
    const o = await org();
    const other = await org();
    const theirs = randomUUID();
    await seed(other.orgId, [{ at: '2026-10-05T03:00:00Z', actorId: other.owner, command: 'kernel.proposal.approve', targetType: 'kernel.proposal', targetId: theirs }]);
    const total = AUDIT_PAGE_SIZE * 2 + 7;
    // Pairs of rows at the same instant, so the cursor's id breaks ties.
    const mine = await seed(
      o.orgId,
      Array.from({ length: total }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 1) + Math.floor(i / 2) * 60_000).toISOString(), actorId: o.owner, command: 'kernel.org.set_address' })),
    );
    const seen: AuditEntry[] = [];
    let before: { at: string; id: string } | undefined;
    for (;;) {
      const page = await list(o, o.owner, { ...SEEDED, ...(before ? { before } : {}) });
      seen.push(...page.items);
      if (!page.more) break;
      const last = page.items.at(-1) as AuditEntry;
      before = { at: last.at, id: last.id };
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((s) => s.id))).toEqual(new Set(mine));
    for (let i = 1; i < seen.length; i++) {
      const [p, q] = [seen[i - 1] as AuditEntry, seen[i] as AuditEntry];
      expect(p.at > q.at || (p.at === q.at && p.id > q.id)).toBe(true);
    }
    expect((await seeded(o, o.owner, { targetId: theirs }))).toEqual([]);
    expect((await seeded(other, other.owner)).map((i) => i.targetId)).toEqual([theirs]);
  });

  it('never shows what looks like a secret in a row detail', async () => {
    const o = await org();
    await seed(o.orgId, [
      {
        at: '2026-10-01T03:00:00Z',
        actorId: o.owner,
        command: 'kernel.channel.connect',
        detail: { provider: 'bluesky', token: 'tok-123', nested: { apiKey: 'k-456', sessionId: 's-789', manifest_key: 'm', input_sha256: 'h' }, note: 'xin chào\nbạn', ids: [1, 2, 3] },
      },
    ]);
    const [row] = await seeded(o, o.owner);
    const line = row?.detail ?? '';
    expect(line).toContain('provider=bluesky');
    expect(line).toContain('token=[ẩn]');
    expect(line).toContain('nested.apiKey=[ẩn]');
    expect(line).toContain('nested.sessionId=[ẩn]');
    expect(line).toContain('nested.manifest_key=[ẩn]');
    expect(line).toContain('nested.input_sha256=[ẩn]');
    expect(line).toContain('note=xin chào bạn');
    expect(line).toContain('ids=[1, 2, 3]');
    for (const secret of ['tok-123', 'k-456', 's-789']) expect(line).not.toContain(secret);
  });

  it('exports the filtered list as CSV, with formulas kept as text and its own audit row', async () => {
    const o = await org('=HYPERLINK("http://x")');
    await seed(o.orgId, [
      { at: '2026-10-01T03:00:00Z', actorId: o.owner, command: 'kernel.proposal.approve', detail: { reason: 'a, "b"' } },
      { at: '2026-10-02T03:00:00Z', actorId: o.owner, command: 'finance.journal.export' },
    ]);
    const out = await rt.execute<AuditExport>('kernel.audit.export', { ...SEEDED, command: 'kernel.' }, { actor: asUser(o.admin), orgId: o.orgId });
    expect(out.rows).toBe(1);
    expect(out.filename).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = out.csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(out.csv.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe(AUDIT_CSV_HEAD.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(lines[1]).toContain('"reason=a, ""b"""');
    const { rows } = await admin((c) =>
      c.query("SELECT actor_id, outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.audit.export'", [o.orgId]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: o.admin, outcome: 'ok', detail: { rows: 1, filter: { ...SEEDED, command: 'kernel.' } } });
  });

  it('refuses an export longer than the limit rather than cutting it', async () => {
    const o = await org();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, command, command_id, outcome, input_sha256, detail)
         SELECT $1, timestamptz '2026-10-01 00:00Z' + make_interval(mins => g), 'system', 'kernel.test.bulk', gen_random_uuid(), 'ok', repeat('a', 64), '{}'
         FROM generate_series(1, $2::int) g`,
        [o.orgId, AUDIT_EXPORT_LIMIT + 1],
      ),
    );
    await expect(rt.execute('kernel.audit.export', { command: 'kernel.test.bulk' }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'AUDIT_EXPORT_TOO_LARGE', status: 422 });
    const out = await rt.execute<AuditExport>('kernel.audit.export', { command: 'kernel.test.bulk', to: '2026-10-01' }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(out.rows).toBeLessThanOrEqual(AUDIT_EXPORT_LIMIT);
  });
});
