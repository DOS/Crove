// Weekly usage report (issue #311) on a real PostgreSQL 17: crove_kernel.usage_weekly() over seeded audit rows, files
// and proposals of two orgs across three weeks, read as crove_reporter through the CLI's reader; the journal export's
// audit row written by the real command; and no tenant content in the result. Privileges (who may execute it) are in
// test/invariant/usage-report.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its
// own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { formatUsage, readUsage, runUsageReport, type UsageRow } from '../src/usage-report.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const TZ = 'Asia/Ho_Chi_Minh';
// Content that must never come out of the report.
const SECRET = 'secret-usage-311';

const suite = ADMIN ? describe : describe.skip;

suite('weekly usage report (#311)', () => {
  const dbName = `crove_test_usage_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let reporterUrl = '';
  let appPool: pg.Pool;
  let appDb: Db;
  let runtime: Runtime;
  const users: Record<'ownerA' | 'ownerB' | 'u1' | 'u2' | 'u3' | 'u4', string> = { ownerA: '', ownerB: '', u1: '', u2: '', u3: '', u4: '' };
  let orgA = '';
  let orgB = '';
  // Monday 00:00 (Asia/Ho_Chi_Minh) of this week, last week and the week before, as dates and instants.
  const weeks = { this: '', last: '', prev: '' };
  let lastStart: Date;
  let prevStart: Date;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  const at = (start: Date, hours: number) => new Date(start.getTime() + hours * 3600_000);

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_reporter: 'test-reporter-pw' });
    reporterUrl = login('crove_reporter', 'test-reporter-pw');
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    appDb = createDb(appPool);
    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(appDb, { issuer: 'usage-test', subject: key, email: `${key}-${SECRET}@usage.test`, name: `${key} ${SECRET}` });
    }
    // Creating the orgs is this week's activity of the two owners.
    ({ orgId: orgA } = await createOrg(runtime, { type: 'user', userId: users.ownerA, aal: 'aal1' }, 'Alpha Co'));
    ({ orgId: orgB } = await createOrg(runtime, { type: 'user', userId: users.ownerB, aal: 'aal1' }, 'Beta Co'));

    await admin(async (c) => {
      const { rows } = await c.query<{ this: string; last: string; prev: string; last_start: Date; prev_start: Date }>(
        `WITH w AS (SELECT date_trunc('week', timezone($1, now())) AS monday)
         SELECT monday::date::text AS this, (monday - interval '7 days')::date::text AS last, (monday - interval '14 days')::date::text AS prev,
                timezone($1, monday - interval '7 days') AS last_start, timezone($1, monday - interval '14 days') AS prev_start
         FROM w`,
        [TZ],
      );
      const row = rows[0] as (typeof rows)[number];
      Object.assign(weeks, { this: row.this, last: row.last, prev: row.prev });
      lastStart = row.last_start;
      prevStart = row.prev_start;

      const file = async (org: string, source: 'upload' | 'email', created: Date) => {
        const id = randomUUID();
        const sha = randomUUID().replace(/-/g, '').padEnd(64, '0');
        await c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'application/xml', 10, $7, $8)`,
          [org, id, sha, `org/${org}/${sha}`, `content:${sha}`, `${SECRET}-invoice.xml`, source, created],
        );
        return id;
      };
      const proposal = async (org: string, fileId: string | null) => {
        const id = randomUUID();
        await c.query(
          `INSERT INTO crove_kernel.proposal (org_id, id, kind, command, title, payload, source_file_id, status)
           VALUES ($1, $2, 'finance.purchase', 'finance.purchase.record', $3, $4, $5, 'executed')`,
          [org, id, `${SECRET} title`, JSON.stringify({ note: SECRET }), fileId],
        );
        return id;
      };
      const audit = async (
        org: string,
        when: Date,
        command: string,
        options: { actor?: string | null; outcome?: string; target?: string; detail?: Record<string, unknown> } = {},
      ) => {
        const actor = options.actor ?? null;
        await c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            org,
            when,
            actor ? 'user' : 'system',
            actor,
            command,
            randomUUID(),
            options.outcome ?? 'ok',
            options.target ? 'kernel.proposal' : null,
            options.target ?? null,
            '0'.repeat(64),
            JSON.stringify({ note: SECRET, ...options.detail }),
          ],
        );
      };

      // Org A, last week: two uploads and one email; approvals after 2 h (unedited), 4 h (edited first) and 24 h
      // (an edit that changed nothing does not count), a rejection, a journal export, a refused approval by u3 and
      // a system row, neither of which makes anyone active.
      const f1 = await file(orgA, 'upload', at(lastStart, 32));
      const f2 = await file(orgA, 'upload', at(lastStart, 32));
      const f3 = await file(orgA, 'email', at(lastStart, 33));
      const [p1, p2, p3, p4] = [await proposal(orgA, f1), await proposal(orgA, f2), await proposal(orgA, f3), await proposal(orgA, null)];
      await audit(orgA, at(lastStart, 33), 'kernel.inbound.receive');
      await audit(orgA, at(lastStart, 34), 'kernel.proposal.approve', { actor: users.u1, target: p1 });
      await audit(orgA, at(lastStart, 33.5), 'kernel.proposal.edit', { actor: users.u2, target: p2, detail: { revision: 2 } });
      await audit(orgA, at(lastStart, 36), 'kernel.proposal.approve', { actor: users.u1, target: p2 });
      await audit(orgA, at(lastStart, 50), 'kernel.proposal.edit', { actor: users.u2, target: p3 });
      await audit(orgA, at(lastStart, 57), 'kernel.proposal.approve', { actor: users.u1, target: p3 });
      await audit(orgA, at(lastStart, 40), 'kernel.proposal.reject', { actor: users.u2, target: p4 });
      await audit(orgA, at(lastStart, 41), 'finance.journal.export', { actor: users.u2, detail: { entries: 3 } });
      await audit(orgA, at(lastStart, 42), 'kernel.proposal.approve', { actor: users.u3, outcome: 'denied', target: p4 });
      // An edit row of another org with the same target id does not mark org A's proposal as edited.
      await audit(orgB, at(lastStart, 33), 'kernel.proposal.edit', { actor: users.u4, target: p1, detail: { revision: 2 } });

      // Org B, last week: one upload approved after 30 min, an org export (system), and a restore's re-record of that
      // export, which is not another export (#1867).
      const fb1 = await file(orgB, 'upload', at(lastStart, 80));
      const pb1 = await proposal(orgB, fb1);
      await audit(orgB, at(lastStart, 80.5), 'kernel.proposal.approve', { actor: users.u4, target: pb1 });
      await audit(orgB, at(lastStart, 81), 'kernel.org.export.record');
      await audit(orgB, at(lastStart, 82), 'kernel.org.export.record', { detail: { rebind: true } });

      // Org B, the week before: an upload approved one second before last week began, and an older upload outside
      // a 3-week report.
      const fb2 = await file(orgB, 'upload', at(prevStart, 1));
      const pb2 = await proposal(orgB, fb2);
      await audit(orgB, new Date(lastStart.getTime() - 1000), 'kernel.proposal.approve', { actor: users.u4, target: pb2 });
      await file(orgB, 'upload', at(prevStart, -24));
    });

    // This week: a journal export through the real command (its audit row is what the report counts).
    await runtime.execute('finance.journal.export', { entries: 0 }, { actor: { type: 'user', userId: users.ownerA, aal: 'aal1' }, orgId: orgA });
  });

  afterAll(async () => {
    await appPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const zero = {
    active_orgs: 0,
    active_users: 0,
    documents_uploaded: 0,
    documents_emailed: 0,
    proposals_approved: 0,
    approved_without_edits: 0,
    proposals_rejected: 0,
    median_upload_to_approval_seconds: null,
    journal_exports: 0,
    org_exports: 0,
  };
  const iso = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    // ISO week number: the Thursday of the week decides the year.
    const thursday = new Date(d.getTime() + 3 * 86_400_000);
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const week = Math.floor((thursday.getTime() - yearStart.getTime()) / (7 * 86_400_000)) + 1;
    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };

  it('counts each week for the deployment: activity, documents, approvals without edits, the median and exports', async () => {
    const rows = await readUsage(reporterUrl, { weeks: 3, byOrg: false, csv: false, timeZone: TZ });
    expect(rows).toEqual([
      {
        ...zero,
        week_start: weeks.prev,
        iso_week: iso(weeks.prev),
        org_id: null,
        org_name: null,
        active_orgs: 1,
        active_users: 1,
        documents_uploaded: 1,
        proposals_approved: 1,
        approved_without_edits: 1,
        median_upload_to_approval_seconds: 7 * 86_400 - 3600 - 1,
      },
      {
        week_start: weeks.last,
        iso_week: iso(weeks.last),
        org_id: null,
        org_name: null,
        active_orgs: 2,
        active_users: 3,
        documents_uploaded: 3,
        documents_emailed: 1,
        proposals_approved: 4,
        approved_without_edits: 3,
        proposals_rejected: 1,
        // Median of 30 min, 2 h, 4 h and 24 h.
        median_upload_to_approval_seconds: 10_800,
        journal_exports: 1,
        org_exports: 1,
      },
      {
        ...zero,
        week_start: weeks.this,
        iso_week: iso(weeks.this),
        org_id: null,
        org_name: null,
        // The owners created their orgs; owner A exported the journal.
        active_orgs: 2,
        active_users: 2,
        journal_exports: 1,
      },
    ]);
  });

  it('adds a row per active org with --by-org, and leaves weeks outside the range out', async () => {
    const rows = await readUsage(reporterUrl, { weeks: 2, byOrg: true, csv: false, timeZone: TZ });
    const last = rows.filter((r) => r.week_start === weeks.last);
    expect(rows.map((r) => r.week_start)).not.toContain(weeks.prev);
    expect(last.map((r) => r.org_name)).toEqual([null, ...(orgA < orgB ? ['Alpha Co', 'Beta Co'] : ['Beta Co', 'Alpha Co'])]);
    const a = last.find((r) => r.org_id === orgA) as UsageRow;
    expect(a).toMatchObject({
      active_orgs: 1,
      active_users: 2,
      documents_uploaded: 2,
      documents_emailed: 1,
      proposals_approved: 3,
      approved_without_edits: 2,
      proposals_rejected: 1,
      median_upload_to_approval_seconds: 14_400,
      journal_exports: 1,
      org_exports: 0,
    });
    // Org B's only user activity is its approval; its org export is a system row.
    const b = last.find((r) => r.org_id === orgB) as UsageRow;
    expect(b).toMatchObject({ active_orgs: 1, active_users: 1, documents_uploaded: 1, proposals_approved: 1, approved_without_edits: 1, median_upload_to_approval_seconds: 1800, org_exports: 1 });
  });

  it('returns counts only: no file names, titles, payloads, emails or user ids', async () => {
    const totals = await readUsage(reporterUrl, { weeks: 3, byOrg: false, csv: false, timeZone: TZ });
    const byOrg = await readUsage(reporterUrl, { weeks: 3, byOrg: true, csv: false, timeZone: TZ });
    for (const rows of [totals, byOrg]) {
      const text = JSON.stringify(rows);
      expect(text).not.toContain(SECRET);
      for (const id of Object.values(users)) expect(text).not.toContain(id);
    }
    // Without --by-org there is no org at all.
    expect(totals.every((r) => r.org_id === null && r.org_name === null)).toBe(true);
    expect(new Set(byOrg.map((r) => r.org_id))).toEqual(new Set([null, orgA, orgB]));
  });

  it('refuses an unknown time zone and clamps the number of weeks', async () => {
    await expect(readUsage(reporterUrl, { weeks: 1, byOrg: false, csv: false, timeZone: 'Mars/Olympus' })).rejects.toMatchObject({ code: '22023' });
    const reporter = new pg.Client({ connectionString: reporterUrl });
    await reporter.connect();
    try {
      const { rows } = await reporter.query(`SELECT count(*)::int AS n FROM crove_kernel.usage_weekly(1000)`);
      expect(rows).toEqual([{ n: 104 }]);
      const none = await reporter.query(`SELECT count(*)::int AS n FROM crove_kernel.usage_weekly(0)`);
      expect(none.rows).toEqual([{ n: 1 }]);
    } finally {
      await reporter.end();
    }
  });

  it('prints a table or CSV through the usage-report role, and refuses a privileged login', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUsageReport(['--weeks', '2', '--by-org', '--csv'], { REPORTER_DATABASE_URL: reporterUrl }, { log: (t) => out.push(t), error: (l) => err.push(l) });
    expect({ code, err }).toEqual({ code: 0, err: [] });
    const lines = (out[0] ?? '').split('\n');
    expect(lines[0]).toBe(
      'week,from,org_id,org,active_orgs,active_users,uploaded,emailed,approved,approved_unedited,unedited_pct,rejected,median_upload_to_approval_h,journal_exports,org_exports',
    );
    expect(lines).toContain(`${iso(weeks.last)},${weeks.last},ALL,ALL,2,3,3,1,4,3,75,1,3.0,1,1`);
    expect(formatUsage([], { byOrg: false, csv: false })).toContain('active_users');

    const refused: string[] = [];
    expect(await runUsageReport([], { REPORTER_DATABASE_URL: adminUrl }, { log: () => {}, error: (l) => refused.push(l) })).toBe(2);
    expect(refused.join('\n')).toMatch(/refusing to report as .*superuser or BYPASSRLS/);
  });
});
