// SPDX-License-Identifier: AGPL-3.0-only
// What the posting path tells its caller (#1925) on a real PostgreSQL 17. postJournalEntry says whether it replayed: a
// new posting is { replayed: false }, the same revision and payload again (in another command or the same one) is
// { replayed: true } with the same entry and nothing written. A replay of an entry no longer in force (its source
// re-posted as a later revision, or the entry reversed) is refused (POSTING_SUPERSEDED). postNewEntry, the path of every
// command that posts a source it just made, refuses any replay (ALREADY_POSTED). The revision rules themselves are in
// finance-source-revision.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own
// database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand } from '@crove/kernel-runtime';
import { postJournalEntry, postNewEntry } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const LINES = [
  { lineNo: 1, accountCode: '6422', debit: '100000', credit: '0', partyId: null, memo: null },
  { lineNo: 2, accountCode: '331', debit: '0', credit: '100000', partyId: null, memo: null },
];
const mirror = LINES.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
const CHANGED = [
  { ...LINES[0], debit: '90000' },
  { ...LINES[1], credit: '90000' },
] as typeof LINES;

const zPosting = z.object({
  sourceType: z.string().default('test.source'),
  sourceId: z.string(),
  revision: z.number().int().optional(),
  reverses: z.string().optional(),
  date: z.string().default('2026-10-01'),
  changed: z.boolean().default(false),
  times: z.number().int().default(1),
});
type PostingInput = z.input<typeof zPosting>;

const posting = (p: z.output<typeof zPosting>) => ({
  entryDate: p.date,
  description: 'Mua văn phòng phẩm',
  sourceType: p.sourceType,
  sourceId: p.sourceId,
  ...(p.revision ? { sourceRevision: p.revision } : {}),
  ...(p.reverses ? { reversesEntryId: p.reverses } : {}),
  lines: p.reverses ? mirror : p.changed ? CHANGED : LINES,
});

// Posts `times` times in one command and answers what each call returned.
const post = defineCommand({
  name: 'test.ledger.post',
  input: zPosting,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner'],
  handler: async (ctx, input) => {
    const out = [];
    for (let i = 0; i < input.times; i++) out.push(await postJournalEntry(ctx, posting(input)));
    return out;
  },
});
const postNew = defineCommand({
  name: 'test.ledger.post_new',
  input: zPosting,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner'],
  handler: async (ctx, input) => ({ id: await postNewEntry(ctx, posting(input)) }),
});

const suite = ADMIN ? describe : describe.skip;

suite('the posting path tells a replay from a new posting (#1925)', () => {
  const dbName = `crove_test_posting_replay_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let orgId = '';
  let userId = '';

  const run = (name: string, input: PostingInput) => runtime.execute(name, input, { actor: { type: 'user', userId, aal: 'aal1' }, orgId });
  const many = (input: PostingInput) => run('test.ledger.post', input) as Promise<Array<{ id: string; replayed: boolean }>>;
  const entries = async (sourceId: string) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (
        await c.query<{ id: string; source_revision: number }>('SELECT id, source_revision FROM crove_finance.journal_entry WHERE org_id = $1 AND source_id = $2 ORDER BY source_revision', [
          orgId,
          sourceId,
        ])
      ).rows;
    } finally {
      await c.end();
    }
  };

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
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, post, postNew], queries: kernelQueries({ inboundDomain: null }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'posting-replay', email: 'replay@posting.test', name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Ghi lại')).orgId;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('says a new posting is new, and the same revision again, in another command or the same one, a replay', async () => {
    const sourceId = randomUUID();
    const [first] = await many({ sourceId });
    expect(first).toEqual({ id: expect.any(String), replayed: false });
    expect(await many({ sourceId })).toEqual([{ id: first?.id, replayed: true }]);
    expect(await entries(sourceId)).toEqual([{ id: first?.id, source_revision: 1 }]);

    const twice = randomUUID();
    const both = await many({ sourceId: twice, times: 2 });
    expect(both).toEqual([
      { id: expect.any(String), replayed: false },
      { id: both[0]?.id, replayed: true },
    ]);
    expect(await entries(twice)).toHaveLength(1);
  });

  it('refuses a replay of a revision no longer in force: reversed, or re-posted as a later revision', async () => {
    const sourceId = randomUUID();
    const [first] = await many({ sourceId });
    await many({ sourceType: 'test.reversal', sourceId: randomUUID(), reverses: first?.id, date: '2026-10-05' });
    // Reversed, and nothing posted after it: the retried request would take the reversed entry for the one in force.
    await expect(many({ sourceId })).rejects.toMatchObject({
      code: 'POSTING_SUPERSEDED',
      status: 409,
      details: { sourceType: 'test.source', sourceId, revision: 1, entryId: first?.id, reason: 'reversed' },
    });
    const [second] = await many({ sourceId, revision: 2, changed: true, date: '2026-10-06' });
    expect(second).toEqual({ id: expect.any(String), replayed: false });
    await expect(many({ sourceId })).rejects.toMatchObject({ code: 'POSTING_SUPERSEDED', details: { revision: 1, entryId: first?.id, reason: 'later_revision' } });
    // The entry in force still replays.
    expect(await many({ sourceId, revision: 2, changed: true, date: '2026-10-06' })).toEqual([{ id: second?.id, replayed: true }]);
    expect((await entries(sourceId)).map((e) => e.source_revision)).toEqual([1, 2]);
  });

  it('refuses any replay on the path of a command that posts a source it just made', async () => {
    const sourceId = randomUUID();
    const { id } = (await run('test.ledger.post_new', { sourceId })) as { id: string };
    await expect(run('test.ledger.post_new', { sourceId })).rejects.toMatchObject({
      code: 'ALREADY_POSTED',
      status: 409,
      details: { sourceType: 'test.source', sourceId, revision: 1, entryId: id },
    });
    expect(await entries(sourceId)).toEqual([{ id, source_revision: 1 }]);
  });
});
