// SPDX-License-Identifier: AGPL-3.0-only
// A bulk delete of notes or to-dos sends a bounded number of stream hints (issue #1992), on PostgreSQL 17: one per org
// and audience, routed as a row's hint is (crove_kernel.stream_notify: a to-do to its owner, a note to its author, a
// shared note also with `+shared`), never one per row. A delete of one row sends that row's hint, as before. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; the run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { parseHint } from '../src/stream.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DONE = 'stream-delete-bounded:done';
const suite = ADMIN ? describe : describe.skip;

suite('stream hints of a bulk delete (#1992)', () => {
  const dbName = `crove_test_stream_delete_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: Runtime;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org(): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'stream-delete', subject: `owner-${tag}`, email: `owner-${tag}@stream-delete.test`, name: null });
    return (await createOrg(app, { type: 'user', userId: owner, aal: 'aal1' }, `Xóa ${tag}`)).orgId;
  }

  // The crove_stream payloads the statements send, in the order they come, up to a marker sent after them.
  async function hintsOf(statements: (c: pg.Client) => Promise<void>): Promise<string[]> {
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const payloads: string[] = [];
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    listener.on('notification', (m) => {
      if (m.channel !== 'crove_stream' || !m.payload) return;
      if (m.payload === DONE) done();
      else payloads.push(m.payload);
    });
    await listener.query('LISTEN crove_stream');
    try {
      await admin(statements);
      await admin((c) => c.query(`SELECT pg_catalog.pg_notify('crove_stream', $1)`, [DONE]));
      await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out; ${payloads.length} payloads`)), 10_000))]);
      return payloads;
    } finally {
      await listener.end();
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    app = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries],
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('sends one hint per org and audience for a delete of hundreds of rows, routed as each row would be', async () => {
    const [first, second] = [await org(), await org()];
    const [ann, binh, chi] = [randomUUID(), randomUUID(), randomUUID()];
    // 330 to-dos and 300 notes over two orgs: Ann's private and shared notes are two audiences, Bình's shared notes a
    // third; Ann's and Bình's to-dos two more in the first org, Chi's one in the second.
    await admin(async (c) => {
      const todos = `INSERT INTO crove_notes.todo (org_id, owner_user_id, title, sort_key) SELECT $1::uuid, $2::uuid, 'Việc ' || n, 'V' || n FROM generate_series(1, $3::integer) n`;
      await c.query(todos, [first, ann, 200]);
      await c.query(todos, [first, binh, 100]);
      await c.query(todos, [second, chi, 30]);
      const notes = `INSERT INTO crove_notes.note (org_id, author_user_id, visibility, title) SELECT $1::uuid, $2::uuid, $3::text, 'Ghi chú ' || n FROM generate_series(1, $4::integer) n`;
      await c.query(notes, [first, ann, 'private', 150]);
      await c.query(notes, [first, ann, 'org', 100]);
      await c.query(notes, [first, binh, 'org', 50]);
    });
    const ids = await admin(async (c) => ({
      todos: (await c.query<{ id: string; org_id: string; owner_user_id: string }>('SELECT id, org_id, owner_user_id FROM crove_notes.todo WHERE org_id = ANY($1)', [[first, second]])).rows,
      notes: (await c.query<{ id: string; author_user_id: string; visibility: string }>('SELECT id, author_user_id, visibility FROM crove_notes.note WHERE org_id = $1', [first])).rows,
    }));
    expect(ids.todos).toHaveLength(330);
    expect(ids.notes).toHaveLength(300);

    const payloads = await hintsOf(async (c) => {
      await c.query('DELETE FROM crove_notes.todo WHERE org_id = ANY($1)', [[first, second]]);
      await c.query('DELETE FROM crove_notes.note WHERE org_id = $1', [first]);
    });

    // Six hints for 630 rows, each one the API parses and routes to that audience alone.
    const hints = payloads.map((p) => ({ payload: p, parsed: parseHint(p) }));
    expect(hints.map((h) => h.parsed === null)).not.toContain(true);
    const routes = hints.map(({ parsed }) => `${parsed?.orgId} ${parsed?.hint.type} @${parsed?.userId}${parsed?.shared ? '+shared' : ''}`).sort();
    expect(routes).toEqual(
      [`${first} todo @${ann}`, `${first} todo @${binh}`, `${second} todo @${chi}`, `${first} note @${ann}`, `${first} note @${ann}+shared`, `${first} note @${binh}+shared`].sort(),
    );
    // The id a hint names is one of the rows of its own audience: a private note's id never rides on a shared hint.
    for (const { parsed } of hints) {
      if (parsed?.hint.type === 'todo') {
        expect(ids.todos.find((t) => t.id === parsed.hint.id)).toMatchObject({ org_id: parsed.orgId, owner_user_id: parsed.userId });
      } else {
        expect(ids.notes.find((n) => n.id === parsed?.hint.id)).toMatchObject({ author_user_id: parsed?.userId, visibility: parsed?.shared ? 'org' : 'private' });
      }
    }
  });

  it('sends the hint of the one row a single delete removes, and nothing for a delete that removes none', async () => {
    const orgId = await org();
    const [ann, binh] = [randomUUID(), randomUUID()];
    const { todo, note } = await admin(async (c) => ({
      todo: (await c.query<{ id: string }>(`INSERT INTO crove_notes.todo (org_id, owner_user_id, title, sort_key) VALUES ($1, $2, 'Một việc', 'V') RETURNING id`, [orgId, ann])).rows[0]?.id,
      note: (await c.query<{ id: string }>(`INSERT INTO crove_notes.note (org_id, author_user_id, visibility, title) VALUES ($1, $2, 'org', 'Chung') RETURNING id`, [orgId, binh])).rows[0]?.id,
    }));
    const payloads = await hintsOf(async (c) => {
      await c.query('DELETE FROM crove_notes.todo WHERE org_id = $1 AND id = $2', [orgId, todo]);
      await c.query('DELETE FROM crove_notes.note WHERE org_id = $1 AND id = $2', [orgId, note]);
      await c.query('DELETE FROM crove_notes.note WHERE org_id = $1', [orgId]);
    });
    expect(payloads).toEqual([`${orgId} todo ${todo} @${ann}`, `${orgId} note ${note} @${binh}+shared`]);
  });

  it('keeps the statement trigger to deletes, and its function to nobody', async () => {
    const rows = await admin(
      async (c) =>
        (
          await c.query<{ tbl: string; name: string; statement: boolean; on_delete: boolean; on_insert: boolean }>(
            `SELECT t.tgrelid::regclass::text AS tbl, t.tgname AS name, (t.tgtype & 1) = 0 AS statement,
                    (t.tgtype & 8) <> 0 AS on_delete, (t.tgtype & 4) <> 0 AS on_insert
             FROM pg_catalog.pg_trigger t
             WHERE t.tgrelid IN ('crove_notes.note'::regclass, 'crove_notes.todo'::regclass) AND t.tgname IN ('stream_hint', 'stream_hint_delete')
             ORDER BY 1, 2`,
          )
        ).rows,
    );
    expect(rows).toEqual([
      { tbl: 'crove_notes.note', name: 'stream_hint', statement: false, on_delete: false, on_insert: true },
      { tbl: 'crove_notes.note', name: 'stream_hint_delete', statement: true, on_delete: true, on_insert: false },
      { tbl: 'crove_notes.todo', name: 'stream_hint', statement: false, on_delete: false, on_insert: true },
      { tbl: 'crove_notes.todo', name: 'stream_hint_delete', statement: true, on_delete: true, on_insert: false },
    ]);
    const callers = await admin(
      async (c) =>
        (
          await c.query<{ role: string }>(
            `SELECT r.rolname AS role FROM pg_catalog.pg_roles r
             WHERE r.rolname = ANY (ARRAY['crove_tenant', 'crove_app', 'crove_worker', 'crove_definer_tenant', 'crove_prober'])
               AND pg_catalog.has_function_privilege(r.oid, 'crove_kernel.stream_notify_deleted()', 'EXECUTE')`,
          )
        ).rows,
    );
    expect(callers).toEqual([]);
  });
});
