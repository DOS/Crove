// The Phase 1 load test (issue #998) runs end to end on a small scale: its own database, the seeded parties, the
// commands, queries and outbox phases, then the database dropped. The full size runs by hand (docs/runbooks/load-test.md).
// Set CROVE_TEST_ADMIN_URL to a superuser URL.
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { judge, runLoad } from '../load/load-test.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const suite = ADMIN ? describe : describe.skip;

suite('load test on PostgreSQL (#998)', () => {
  it('measures every phase on a small scale and drops its database', async () => {
    const lines: string[] = [];
    const result = await runLoad(
      { adminUrl: ADMIN as string, parties: 300, commands: 20, concurrency: 4, queries: 2, rate: 20, seconds: 1, keep: false },
      (line) => lines.push(line),
    );
    expect(result.parties).toBe(300);
    for (const c of result.commands) expect(c).toMatchObject({ count: 20, failed: 0, firstError: null });
    expect(result.queries.map((q) => q.count)).toEqual([2, 2, 2, 2]);
    expect(result.outbox).toMatchObject({ produced: 20, relayed: 20, backlog: 1000 });
    expect(result.outbox.lagP95).not.toBeNull();
    expect(judge(result).filter((v) => v.ok !== null).every((v) => v.ok)).toBe(true);

    const name = lines.find((l) => l.startsWith('database '))?.split(' ')[1];
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      expect((await root.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
    } finally {
      await root.end();
    }
  }, 300_000);
});
