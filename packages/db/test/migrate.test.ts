import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyConcurrentIndexes, CONCURRENT_INDEX_MARKER, concurrentIndexes, readMigrations, takeMigrateLock } from '../src/migrate.ts';

describe('migration files', () => {
  it('hash the same with CRLF and LF line endings', async () => {
    const lf = await mkdtemp(join(tmpdir(), 'crove-lf-'));
    const crlf = await mkdtemp(join(tmpdir(), 'crove-crlf-'));
    const name = '20260101000000_crove_kernel_test.sql';
    await writeFile(join(lf, name), 'SELECT 1;\nSELECT 2;\n');
    await writeFile(join(crlf, name), 'SELECT 1;\r\nSELECT 2;\r\n');
    const [a] = await readMigrations(lf);
    const [b] = await readMigrations(crlf);
    expect(a?.sha256).toBe(b?.sha256);
  });

  it('rejects files that break the naming rule', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crove-bad-'));
    await writeFile(join(dir, 'bad.sql'), 'SELECT 1;');
    await expect(readMigrations(dir)).rejects.toThrow(/naming rule/);
  });

  it('rejects two files with the same version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crove-dup-'));
    await writeFile(join(dir, '20260101000000_crove_kernel_a.sql'), 'SELECT 1;');
    await writeFile(join(dir, '20260101000000_crove_kernel_b.sql'), 'SELECT 2;');
    await expect(readMigrations(dir)).rejects.toThrow(/duplicate migration version 20260101000000/);
  });

  it('the repository migrations have unique versions', async () => {
    const dir = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
    const files = await readMigrations(dir);
    expect(new Set(files.map((f) => f.version)).size).toBe(files.length);
  });

  it('reads a file marked to build indexes concurrently, and refuses anything else in it (#1791)', () => {
    const marked = (body: string) => `-- Indexes on a hot table.\n${CONCURRENT_INDEX_MARKER}\n\n${body}`;
    expect(concurrentIndexes('a.sql', 'CREATE INDEX IF NOT EXISTS i ON crove_kernel.t (a);')).toBeNull();
    // The marker counts only among the leading comment lines.
    expect(concurrentIndexes('a.sql', `SELECT 1;\n${CONCURRENT_INDEX_MARKER}\n`)).toBeNull();
    expect(
      concurrentIndexes(
        'a.sql',
        marked(
          "CREATE INDEX CONCURRENTLY IF NOT EXISTS Audit_Event_X_idx ON crove_kernel.audit_event (org_id, occurred_at DESC);\n" +
            "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outbox_y_idx ON crove_kernel.outbox_event USING btree (org_id, (payload->>'k')) INCLUDE (id)\n  WHERE status = 'pending';\n",
        ),
      ),
    ).toEqual([
      { sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS Audit_Event_X_idx ON crove_kernel.audit_event (org_id, occurred_at DESC)', name: 'audit_event_x_idx', schema: 'crove_kernel', table: 'audit_event', unique: false, definition: '(org_id, occurred_at DESC)' },
      {
        sql: "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outbox_y_idx ON crove_kernel.outbox_event USING btree (org_id, (payload->>'k')) INCLUDE (id)\n  WHERE status = 'pending'",
        name: 'outbox_y_idx',
        schema: 'crove_kernel',
        table: 'outbox_event',
        unique: true,
        definition: "USING btree (org_id, (payload->>'k')) INCLUDE (id)\n  WHERE status = 'pending'",
      },
    ]);
    for (const body of [
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_kernel.t (a);\nDROP TABLE crove_kernel.t;',
      'CREATE INDEX CONCURRENTLY i ON crove_kernel.t (a);',
      'CREATE INDEX IF NOT EXISTS i ON crove_kernel.t (a);',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a);',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS ON crove_kernel.t (a);',
      'BEGIN;\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_kernel.t (a);\nCOMMIT;',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_kernel.t (a);\n-- a comment between statements\n',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_kernel.t (a) /* x */;',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_kernel.t ((f($$x$$)));',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "I" ON crove_kernel.t (a);',
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_kernel.t (a) WHERE b = 'x;DROP TABLE crove_kernel.t;--';",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_kernel.t (a) WHERE b = E'\\'';",
      '',
    ]) {
      expect(() => concurrentIndexes('a.sql', marked(body)), body).toThrow(/marked -- crove:concurrent-index but/);
    }
  });

  it('refuses a name longer than the 63 bytes PostgreSQL keeps (#1791 review)', () => {
    const name = `i_${'x'.repeat(62)}`;
    expect(() => concurrentIndexes('a.sql', `${CONCURRENT_INDEX_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON crove_kernel.t (a);\n`)).toThrow(
      new RegExp(`names ${name}, longer than the 63 bytes`),
    );
    expect(concurrentIndexes('a.sql', `${CONCURRENT_INDEX_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ${name.slice(0, 63)} ON crove_kernel.t (a);\n`)).toHaveLength(1);
  });

  it('stops the run when the session settings cannot be restored after good builds, and keeps a build error first (#1791 review)', async () => {
    // A client that answers the settings read and the pinning, refuses the restore and, when told to, the build.
    const client = (buildFails: boolean) =>
      ({
        escapeIdentifier: (s: string) => `"${s}"`,
        query: async (sql: string) => {
          if (sql.includes("current_setting('search_path')")) return { rows: [{ path: 'public', statement: '0', lock: '0' }] };
          if (sql.includes("set_config('search_path', 'pg_catalog, pg_temp'")) return { rows: [] };
          if (sql.includes('set_config($1, $2, false)')) throw new Error('restore refused');
          if (buildFails) throw new Error('build refused');
          return { rows: [] };
        },
      }) as unknown as Parameters<typeof applyConcurrentIndexes>[0];
    await expect(applyConcurrentIndexes(client(false), 'a.sql', [])).rejects.toThrow(/could not restore the session's settings after the index builds: restore refused/);
    const index = { sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_kernel.t (a)', name: 'i', schema: 'crove_kernel', table: 't', unique: false, definition: '(a)' };
    await expect(applyConcurrentIndexes(client(true), 'a.sql', [index])).rejects.toThrow(/build refused/);
  });

  it('refuses user code in an index built outside a transaction, and keeps what PostgreSQL ships (#1803)', () => {
    const build = (definition: string) => concurrentIndexes('a.sql', `${CONCURRENT_INDEX_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_kernel.t ${definition};\n`);
    for (const [definition, why] of [
      ['(crove_kernel.f(a))', /with crove_kernel\.f, a name of a schema other than pg_catalog/],
      ['((a::crove_kernel.money_t))', /with crove_kernel\.money_t/],
      ['((cast(a AS public.t)))', /with public\.t/],
      ['((a::pg_catalog.text::public.t))', /with public\.t/],
      ['((äpg_catalog.f(a)))', /with äpg_catalog\.f/],
      ['(a crove_kernel.my_ops)', /with crove_kernel\.my_ops/],
      ['(a) WHERE public.ok(a)', /with public\.ok/],
      ['(a) WHERE a OPERATOR(crove_kernel.===) 1', /with crove_kernel\./],
      ['USING bloom (a)', /access method bloom, which PostgreSQL does not ship/],
    ] as const) {
      expect(() => build(definition), definition).toThrow(why);
    }
    for (const definition of [
      '(pg_catalog.lower(a))',
      '(lower(a), (b::text), (cast(c AS pg_catalog.int8)))',
      '(a text_pattern_ops)',
      'USING gin (a jsonb_path_ops)',
      "(a) WHERE b = 'crove_kernel.f(x)'",
      '(a) WHERE b > 1.5',
    ]) {
      expect(build(definition), definition).toHaveLength(1);
    }
  });

  it('waits for the migration lock, logs who holds it, and gives up after the maximum wait (#1803)', async () => {
    const client = (freeAfter: number) => {
      let tries = 0;
      return {
        query: async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: ++tries > freeAfter }] };
          if (sql.includes('pg_locks')) return { rows: [{ holder: 'pid 42 (crove-migrate, active)' }] };
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Parameters<typeof takeMigrateLock>[0];
    };
    const log: string[] = [];
    await takeMigrateLock(client(2), { log: (m) => log.push(m), pollMs: 1, logEveryMs: 60_000 });
    expect(log).toEqual(['waiting for the migration lock, held by pid 42 (crove-migrate, active) (waited 0s)', 'took the migration lock after 0s']);
    // Free at once: nothing logged.
    const quiet: string[] = [];
    await takeMigrateLock(client(0), { log: (m) => quiet.push(m), pollMs: 1 });
    expect(quiet).toEqual([]);
    await expect(takeMigrateLock(client(Number.POSITIVE_INFINITY), { pollMs: 1, maxWaitMs: 20 })).rejects.toThrow(
      /another run has held the migration lock for longer than 0s \(pid 42 \(crove-migrate, active\)\)/,
    );
  });

  it('the repository migrations are not copies of each other', async () => {
    // Two parallel renames once left the same migration under two versions, so it ran twice.
    const dir = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
    const files = await readMigrations(dir);
    const byHash = new Map<string, string>();
    for (const f of files) {
      expect(byHash.get(f.sha256), `${f.name} repeats ${byHash.get(f.sha256)}`).toBeUndefined();
      byHash.set(f.sha256, f.name);
    }
  });
});
