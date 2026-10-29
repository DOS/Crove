import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONCURRENT_INDEX_MARKER, concurrentIndexes, readMigrations } from '../src/migrate.ts';

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
      { sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS Audit_Event_X_idx ON crove_kernel.audit_event (org_id, occurred_at DESC)', name: 'audit_event_x_idx', schema: 'crove_kernel', table: 'audit_event' },
      {
        sql: "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outbox_y_idx ON crove_kernel.outbox_event USING btree (org_id, (payload->>'k')) INCLUDE (id)\n  WHERE status = 'pending'",
        name: 'outbox_y_idx',
        schema: 'crove_kernel',
        table: 'outbox_event',
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
