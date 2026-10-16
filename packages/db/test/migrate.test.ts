import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readMigrations } from '../src/migrate.ts';

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
