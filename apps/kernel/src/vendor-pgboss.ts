// `pnpm db:vendor:pgboss`: when the pinned pg-boss expects a schema version no committed migration vendors yet,
// writes the migration that installs (first time) or upgrades crove_jobs to it. Commit the file it writes.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEUES, pgBossSchemaVersion, renderJobsMigration, vendoredSchemaVersion } from './jobs-schema.ts';

const MIGRATIONS = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const target = pgBossSchemaVersion();
const vendored = await vendoredSchemaVersion(MIGRATIONS);
if (vendored === target) {
  console.log(`crove_jobs is vendored at pg-boss schema version ${target}; nothing to do`);
} else if (vendored !== null && vendored > target) {
  throw new Error(`migrations vendor pg-boss schema version ${vendored}, but the installed pg-boss expects ${target}; upgrade pg-boss`);
} else {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const file = join(MIGRATIONS, `${stamp}_crove_jobs_pgboss_v${target}.sql`);
  await writeFile(file, renderJobsMigration(target, vendored, Object.values(QUEUES)));
  console.log(`wrote ${file}${vendored === null ? '' : ` (upgrade from ${vendored})`}`);
}
