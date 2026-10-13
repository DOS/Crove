import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
