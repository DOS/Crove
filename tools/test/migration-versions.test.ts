// The migration runner records each file under its 14-digit version (crove_meta.schema_migrations, primary key), so
// two files with the same version stop every fresh install at the second one. AGENTS.md: keep a new migration's
// timestamp greater than every file on main.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));
// The naming rule the runner enforces (packages/db/src/migrate.ts): <14-digit UTC>_crove_<module>_<desc>.sql.
const FILE_PATTERN = /^(\d{14})_crove_[a-z0-9]+_[a-z0-9_]+\.sql$/;

describe('supabase/migrations', () => {
  it('gives every file its own 14-digit version', () => {
    const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const byVersion = new Map<string, string[]>();
    for (const name of files) {
      const version = FILE_PATTERN.exec(name)?.[1];
      expect(version, `${name} does not follow the migration naming rule`).toBeDefined();
      if (!version) continue;
      byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
    }
    const shared = [...byVersion.values()].filter((names) => names.length > 1);
    expect(shared).toEqual([]);
  });
});
