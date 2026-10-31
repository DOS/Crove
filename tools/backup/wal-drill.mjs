#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Point-in-time restore drill (issue #2120): proves that a database archiving its WAL with tools/backup/wal.sh restores
// to a moment between two writes, and finds the first write but not the second. Runbook:
// docs/runbooks/backup-and-restore.md, "Point in time recovery". tools/backup/drill.mjs runs it after the nightly restore
// drill, so the CI job "Backup and restore drill" covers both.
//   1. starts a database (the pgBackRest image of tools/wal) and a throwaway MinIO behind a self-signed certificate, as a
//      compose project of its own, with the overlay a deployment uses (tools/backup/compose.wal.yml);
//   2. `wal.sh setup`: archiving on, the stanza, the first full base backup;
//   3. writes a first row, waits, notes the time, waits, writes a second row, closes the WAL segment and waits until the
//      archive holds it;
//   4. wipes the database volume and runs `wal.sh restore --to <the noted time>` into the empty volume, starts the
//      database: it replays the WAL up to that time and opens. The first row is there, the second is not, and the
//      restored cluster does not archive;
//   5. wipes the volume again and restores to the end of the archive: both rows are there;
//   6. tears everything down (containers, volumes, the image, the temporary directory).
// Plain Node (26+), no dependencies; needs docker with compose v2 and bash. Environment: DRILL_PREFIX (default
// crove-wal-drill; names the compose project and the image tag), DRILL_BASH (default bash). --keep leaves it running.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const KEEP = process.argv.includes('--keep');
const PREFIX = process.env.DRILL_PREFIX ?? 'crove-wal-drill';
if (!/^[a-z][a-z0-9-]{0,30}$/.test(PREFIX)) throw new Error('DRILL_PREFIX is lower-case letters, digits and -');
const BASH = process.env.DRILL_BASH ?? 'bash';
const DIR = mkdtempSync(join(tmpdir(), `${PREFIX}-`)).replaceAll('\\', '/');
const T0 = Date.now();

const settings = {
  BACKUP_S3_BUCKET: 'crove-wal-drill',
  BACKUP_S3_ACCESS_KEY_ID: 'crove-wal-drill',
  BACKUP_S3_SECRET_ACCESS_KEY: 'crove-wal-drill-secret-0123456789',
  BACKUP_S3_PREFIX: 'drill',
  BACKUP_ENCRYPTION_KEY: 'drill-encryption-key-not-a-secret-0123456789',
  WAL_S3_ENDPOINT: 'minio',
  WAL_S3_PORT: '9000',
  WAL_S3_URI_STYLE: 'path',
  WAL_S3_VERIFY_TLS: 'n',
  WAL_ARCHIVE_TIMEOUT: '10',
  BACKUP_ALERT: 'off',
  CROVE_DIR: DIR,
  WAL_BUILD_CONTEXT: `${ROOT}tools/wal`,
};
const env = {
  ...process.env,
  ...settings,
  DRILL_PROJECT: PREFIX,
  MSYS_NO_PATHCONV: '1',
  MSYS2_ARG_CONV_EXCL: '*',
  // Both files by absolute path; the image is built from the checkout.
  COMPOSE_PATH_SEPARATOR: ',',
  COMPOSE_FILE: `${DIR}/docker-compose.yml,${ROOT}tools/backup/compose.wal.yml`,
  COMPOSE_PROJECT_NAME: PREFIX,
  // The overlay's build context (tools/wal) is outside the drill's directory: compose's bake would ask for the filesystem entitlement.
  BUILDX_BAKE_ENTITLEMENTS_FS: '0',
};

const log = (message) => console.log(`[wal-drill +${Math.round((Date.now() - T0) / 1000)}s] ${message}`);
function assert(condition, message) {
  if (!condition) throw new Error(`wal-drill: ${message}`);
}

const compose = (args, options = {}) => execFileSync('docker', ['compose', ...args], { cwd: DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
function wal(args) {
  const result = spawnSync(BASH, [`${ROOT}tools/backup/wal.sh`, ...args], { cwd: DIR, env, encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert(result.status === 0, `wal.sh ${args.join(' ')} exited ${result.status}`);
  return `${result.stdout}${result.stderr}`;
}
const psql = (sql) => compose(['exec', '-T', 'db', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-c', sql]).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`wal-drill: timed out waiting for ${what}`);
    await sleep(1000);
  }
}

// A fresh, empty database volume: what a new server (or a scratch stack) has before a restore.
function wipeDatabase() {
  compose(['stop', 'db']);
  compose(['rm', '-f', 'db']);
  execFileSync('docker', ['volume', 'rm', '-f', `${PREFIX}_db-data`], { stdio: ['ignore', 'pipe', 'inherit'] });
}

async function startRestored() {
  compose(['up', '-d', 'db']);
  await waitFor('the restored database to open', 120_000, () => psql('SELECT NOT pg_is_in_recovery()') === 't');
}

function teardown() {
  if (KEEP) {
    log(`kept: docker compose -p ${PREFIX} down -v; the directory ${DIR}`);
    return;
  }
  try {
    compose(['down', '-v', '--remove-orphans']);
  } catch (error) {
    console.error('wal-drill: teardown of the project failed', error instanceof Error ? error.message : error);
  }
  try {
    execFileSync('docker', ['image', 'rm', '-f', 'crove-db:local'], { stdio: 'ignore' });
  } catch {
    // another project may still use it
  }
  rmSync(DIR, { recursive: true, force: true });
}

async function main() {
  copyFileSync(`${ROOT}tools/backup/wal-drill.compose.yml`, `${DIR}/docker-compose.yml`);
  writeFileSync(`${DIR}/.env`, Object.entries(settings).filter(([k]) => k !== 'CROVE_DIR').map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

  log('starting the database and the bucket');
  compose(['up', '-d', '--build', '--wait', 'db', 'minio']);
  compose(['run', '--rm', '-T', 'minio-init']);

  log('wal.sh setup');
  const setup = wal(['setup']);
  assert(/WAL archiving is on/.test(setup), 'setup did not say archiving is on');
  assert(psql('SHOW archive_mode') === 'on', 'archive_mode is not on after setup');

  log('writing the first row, noting the time, writing the second row');
  psql('CREATE TABLE pitr (note text PRIMARY KEY, written timestamptz NOT NULL DEFAULT clock_timestamp())');
  psql("INSERT INTO pitr (note) VALUES ('first')");
  await sleep(3000);
  const between = psql('SELECT clock_timestamp()');
  await sleep(3000);
  psql("INSERT INTO pitr (note) VALUES ('second')");
  // The segment holding both writes is closed and must reach the archive before the database is thrown away.
  const closed = psql('SELECT pg_walfile_name(pg_switch_wal())');
  await waitFor('the archive to hold the closed WAL segment', 90_000, () => psql('SELECT last_archived_wal FROM pg_stat_archiver') >= closed);
  log(`archive holds ${closed}; the restore target is ${between}`);
  const info = wal(['info']);
  assert(/full backup/.test(info) && /wal archive min\/max/.test(info), 'wal.sh info does not show a base backup and a WAL range');

  log('restoring to the time between the two writes');
  wipeDatabase();
  wal(['restore', '--to', between]);
  await startRestored();
  assert(psql("SELECT count(*) FROM pitr WHERE note = 'first'") === '1', 'the first row is missing after the point-in-time restore');
  assert(psql("SELECT count(*) FROM pitr WHERE note = 'second'") === '0', 'the second row is there although it was written after the restore target');
  assert(psql('SHOW archive_mode') === 'off', 'the restored cluster archives (it would push into the bucket it came from)');
  log('ok: the first write is there, the second is not, and the restored cluster does not archive');

  log('restoring to the end of the archive');
  wipeDatabase();
  wal(['restore', '--latest']);
  await startRestored();
  assert(psql('SELECT string_agg(note, \',\' ORDER BY note) FROM pitr') === 'first,second', 'a restore to the end of the archive does not hold both rows');
  log('ok: a restore to the end of the archive holds both rows');
}

try {
  await main();
  console.log(`wal-drill: passed in ${Math.round((Date.now() - T0) / 1000)} s`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  try {
    console.error(compose(['logs', '--tail', '60', 'db']));
  } catch {
    // best effort
  }
  process.exitCode = 1;
} finally {
  teardown();
}
