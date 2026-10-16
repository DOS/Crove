// Counts DBOS system schema migrations per SDK release, to size the upgrade cadence a vendored schema would follow.
//
//   node src/schema-churn.ts <sdk-dir> [<sdk-dir> ...]
// (exp-schema.ts and the README install the SDKs under .cache/sdk-<version>.)
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const rows = process.argv.slice(2).map((dir) => {
  const sdk = resolve(dir, 'node_modules', '@dbos-inc', 'dbos-sdk');
  const version: string = require(join(sdk, 'package.json')).version;
  const all: { pg?: string[]; online?: boolean }[] = require(join(sdk, 'dist', 'src', 'sysdb_migrations', 'internal', 'migrations.js')).allMigrations('crove_dbos');
  const nonEmpty = all.filter((m) => (m.pg ?? []).length > 0);
  return { version, schemaVersion: all.length, nonEmptyMigrations: nonEmpty.length, onlineIndexMigrations: nonEmpty.filter((m) => m.online).length };
});
console.log(JSON.stringify(rows, null, 2));
