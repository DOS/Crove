// SPDX-License-Identifier: AGPL-3.0-only
// The outbox guard's one-release allowance (#1970, dropped by #1980): what the previous release emits, which a rollback
// may bring back, still passes the database while ctx.emit refuses it: its CRM cancel title and its session revoke's
// subject. An ordinary test, not the invariant suite: the invariant (test/invariant/event-payload.db.test.ts) holds the
// refusals and the parity of the two rules, and #1980 removes this file with the allowance. Set CROVE_TEST_ADMIN_URL to
// a superuser URL; each run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@crove/db/migrate';
import { eventPayloadProblem } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ID = '0193a3f4-5b6c-7d8e-9f01-23456789abcd';

const suite = ADMIN ? describe : describe.skip;

suite("the outbox guard's one-release allowance for the previous release (#1970)", () => {
  const dbName = `crove_test_evlegacy_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
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
  }, 120_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("still lets the previous release's CRM cancel title and revoke subject through the database only", async () => {
    const legacy: Array<[string, unknown, string]> = [
      ['crm.booking.cancelled', { booking_id: ID, agent_task: { title: 'Khách hủy lịch hẹn: Tư vấn thuế', ref: { type: 'crm.booking', id: ID } } }, 'payload.agent_task.title'],
      ['kernel.session.revoked', { userId: ID, subject: 'auth0|abc', sessionId: ID, scope: 'local' }, 'payload.subject'],
    ];
    for (const [type, payload, path] of legacy) {
      expect(eventPayloadProblem(payload, type)).toBe(`${path}: a string that is neither an id nor a code`);
      const sqlProblem = await withClient(adminUrl, async (c) =>
        (await c.query<{ p: string | null }>('SELECT crove_kernel.event_payload_problem($1, $2::jsonb) AS p', [type, JSON.stringify(payload)])).rows[0]?.p,
      );
      expect(sqlProblem, type).toBeNull();
    }
  });
});
