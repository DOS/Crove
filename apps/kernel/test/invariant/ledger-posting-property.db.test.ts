// Property test of the posting path (issue #138, External-tenant gate T3) on a real PostgreSQL 17: a random set of
// journal lines is accepted by crove_finance.post_journal_entry(), run as the API login role in a tenant context and
// committed, exactly when it has at least 2 lines, every amount fits the book currency (VND: whole dong, #1282) and its
// debits equal its credits. Accepted entries are stored as given; refused ones fail with a check violation, or with
// AMOUNT_SCALE for a fraction of a dong, and leave nothing behind.
// Bounded and deterministic: a fixed seed and 100 runs (override with FC_SEED / FC_RUNS to explore locally; a
// failure prints the seed and the shrunk counterexample).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SEED = Number(process.env.FC_SEED ?? 138);
const RUNS = Number(process.env.FC_RUNS ?? 100);
const ACCOUNTS = ['111', '112', '1331', '156', '331', '642', '6422'];

type Line = { line_no: number; account_code: string; debit: string; credit: string };
type Side = { account: string; debit: boolean; units: bigint };

// Amounts in units of 0.0001 (the scale of crove_finance.amount), as decimal strings. The org books in VND, which has
// no minor units (ADR-0021 decision 1, #1282), so the generated lines use whole dong: one dong is DONG units.
const DONG = 10_000n;
const amount = (units: bigint) => money(units.toString()).dividedBy(10_000).toFixed(4);
const toLines = (sides: Side[]): Line[] =>
  sides.map((s, i) => ({
    line_no: i + 1,
    account_code: s.account,
    debit: s.debit ? amount(s.units) : '0',
    credit: s.debit ? '0' : amount(s.units),
  }));

const side = fc.record({
  account: fc.constantFrom(...ACCOUNTS),
  debit: fc.boolean(),
  units: fc.bigInt({ min: 1n, max: 10n ** 11n }).map((dong) => dong * DONG),
});

// Any lines at all (mostly unbalanced, including 0 and 1 line).
const raw = fc.array(side, { minLength: 0, maxLength: 6 });
// Balanced: the last line takes up the difference on the other side (none needed if the lines already balance).
const balance = (sides: Side[]): Side[] => {
  const net = sides.reduce((acc, s) => (s.debit ? acc + s.units : acc - s.units), 0n);
  if (net === 0n) return sides;
  return [...sides, { account: '331', debit: net < 0n, units: net < 0n ? -net : net }];
};
const balanced = fc.array(side, { minLength: 1, maxLength: 5 }).map(balance);
// Balanced, then one line off by the smallest amount (one dong).
const nearlyBalanced = fc
  .tuple(balanced, fc.nat())
  .map(([sides, pick]) => sides.map((s, i) => (i === pick % sides.length ? { ...s, units: s.units + DONG } : s)));

// Balanced, plus a debit and a credit line of the same amount with a fraction of a dong (0.0001 to 0.9999): it still
// balances, but VND has no minor units, so it is refused (#1282) rather than stored as given or rounded.
const fractional = fc
  .tuple(balanced, fc.bigInt({ min: 1n, max: 10n ** 11n }), fc.bigInt({ min: 1n, max: DONG - 1n }))
  .map(([sides, dong, fraction]): Side[] => [
    ...sides,
    { account: '1331', debit: true, units: dong * DONG + fraction },
    { account: '331', debit: false, units: dong * DONG + fraction },
  ]);

const lineSets = fc.oneof(raw, balanced, nearlyBalanced, fractional).map(toLines);

// accepted: at least 2 lines, whole dong, balanced; scale: at least 2 lines and an amount with a fraction of a dong
// (refused before the balance is looked at); refused: anything else.
function expectedOutcome(lines: Line[]): 'accepted' | 'scale' | 'refused' {
  if (lines.length < 2) return 'refused';
  if (lines.some((l) => !money(l.debit).isInteger() || !money(l.credit).isInteger())) return 'scale';
  const debit = lines.reduce((acc, l) => acc.plus(money(l.debit)), money(0));
  const credit = lines.reduce((acc, l) => acc.plus(money(l.credit)), money(0));
  return debit.equals(credit) ? 'accepted' : 'refused';
}

const suite = ADMIN ? describe : describe.skip;

suite('posting path property (#138)', () => {
  const dbName = `crove_test_posting_prop_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: pg.Client;
  let admin: pg.Client;
  let userId = '';
  let orgId = '';

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 1 });
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'posting-prop', email: 'prop@posting.test', name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Posting Property')).orgId;
    app = new pg.Client({ connectionString: url.toString() });
    await app.connect();
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
  });

  afterAll(async () => {
    await app?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // Posts and commits as crove_app in the org's context; the deferred checks run at COMMIT.
  async function post(lines: Line[], sourceId: string): Promise<{ id: string } | { error: { code?: string; message: string } }> {
    await app.query('BEGIN');
    try {
      await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const { rows } = await app.query<{ id: string }>(
        `SELECT crove_finance.post_journal_entry('2026-10-01', 'property', 'test', $1::uuid, $2::jsonb) AS id`,
        [sourceId, JSON.stringify(lines)],
      );
      await app.query('COMMIT');
      return { id: rows[0]?.id ?? '' };
    } catch (error) {
      await app.query('ROLLBACK').catch(() => {});
      return { error: error as { code?: string; message: string } };
    }
  }

  it('accepts a line set exactly when it has at least 2 lines, whole dong and balances', { timeout: 120_000 }, async () => {
    const seen = { accepted: 0, refused: 0, scale: 0 };
    await fc.assert(
      fc.asyncProperty(lineSets, async (lines) => {
        const sourceId = randomUUID();
        const result = await post(lines, sourceId);
        const stored = await admin.query<{ n: number; debit: string | null; credit: string | null }>(
          `SELECT count(l.*)::int AS n, sum(l.debit)::text AS debit, sum(l.credit)::text AS credit
           FROM crove_finance.journal_entry e LEFT JOIN crove_finance.journal_line l ON l.org_id = e.org_id AND l.entry_id = e.id
           WHERE e.org_id = $1 AND e.source_id = $2`,
          [orgId, sourceId],
        );
        const row = stored.rows[0];
        const outcome = expectedOutcome(lines);
        if (outcome === 'accepted') {
          expect(result).toHaveProperty('id');
          seen.accepted += 1;
          expect(row?.n).toBe(lines.length);
          expect(money(row?.debit ?? '0').equals(lines.reduce((acc, l) => acc.plus(money(l.debit)), money(0)))).toBe(true);
          expect(money(row?.debit ?? '0').equals(money(row?.credit ?? '0'))).toBe(true);
        } else {
          expect(result).toHaveProperty('error');
          seen[outcome] += 1;
          const { error } = result as { error: { code?: string; message: string } };
          if (outcome === 'scale') {
            expect(error).toMatchObject({ code: '22023', message: 'AMOUNT_SCALE' });
          } else {
            expect(error.code).toBe('23514');
            expect(error.message).toMatch(/needs at least 2 lines|does not balance/);
          }
          // Nothing of a refused entry is left.
          expect(row?.n ?? 0).toBe(0);
          const entries = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_finance.journal_entry WHERE org_id = $1 AND source_id = $2`, [
            orgId,
            sourceId,
          ]);
          expect(entries.rows[0]?.n).toBe(0);
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
    // The generators reach every outcome, so no part of the property is vacuous.
    expect(seen.accepted).toBeGreaterThan(0);
    expect(seen.refused).toBeGreaterThan(0);
    expect(seen.scale).toBeGreaterThan(0);
  });
});
