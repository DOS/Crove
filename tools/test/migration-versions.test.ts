// The migration runner records each file under its 14-digit version (crove_meta.schema_migrations, primary key), so
// two files with the same version stop every fresh install at the second one. AGENTS.md: keep a new migration's
// timestamp greater than every file on main.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));

describe('supabase/migrations', () => {
  it('gives every file its own 14-digit version', () => {
    const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const byVersion = new Map<string, string[]>();
    for (const name of files) {
      const version = /^(\d{14})_/.exec(name)?.[1];
      expect(version, `${name} does not start with a 14-digit version`).toBeDefined();
      byVersion.set(version as string, [...(byVersion.get(version as string) ?? []), name]);
    }
    const shared = [...byVersion.values()].filter((names) => names.length > 1);
    expect(shared).toEqual([]);
  });
});
