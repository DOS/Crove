// SPDX-License-Identifier: AGPL-3.0-only
// WAL archiving and point-in-time recovery pieces (issue #2120): the database image keeps the base image of the stack, the
// overlay gives the `db` service the bucket's settings and refuses to start without them, and wal.sh parses. The restore
// itself is proved by tools/backup/wal-drill.mjs (CI job "Backup and restore drill").
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../..');
const digestOf = (file: string) => /postgres:17@(sha256:[0-9a-f]{64})/.exec(readFileSync(resolve(repo, file), 'utf8'))?.[1];

describe('the WAL database image', () => {
  it('is built on the same PostgreSQL image, by digest, as the stack runs', () => {
    expect(digestOf('tools/wal/Dockerfile')).toBeDefined();
    expect(digestOf('tools/wal/Dockerfile')).toBe(digestOf('docker-compose.yml'));
    // The drill's own database and certificate containers use it too.
    expect(digestOf('tools/backup/wal-drill.compose.yml')).toBe(digestOf('docker-compose.yml'));
  });

  it('installs pgBackRest from one series, not whatever is newest', () => {
    expect(readFileSync(resolve(repo, 'tools/wal/Dockerfile'), 'utf8')).toMatch(/pgbackrest=2\.\d+\.\*/);
  });
});

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
describe.skipIf(!hasBash)('wal.sh', () => {
  it('parses, and refuses an unknown command and a bad restore target', () => {
    expect(spawnSync('bash', ['-n', resolve(repo, 'tools/backup/wal.sh')]).status).toBe(0);
    const env = { ...process.env, CROVE_DIR: repo, BACKUP_ALERT: 'off' };
    const run = (...args: string[]) => spawnSync('bash', [resolve(repo, 'tools/backup/wal.sh'), ...args], { env, encoding: 'utf8' });
    const unknown = run('frobnicate');
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown command frobnicate');
    // Refused before anything is stopped: docker is never asked.
    const none = run('restore');
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('--to "<timestamp with time zone>" or --latest');
    const both = run('restore', '--to', '2026-10-31 08:40:00+00', '--latest');
    expect(both.status).toBe(2);
    const naive = run('restore', '--to', '2026-10-31 08:40:00');
    expect(naive.status).toBe(2);
    expect(naive.stderr).toContain('timestamp with its time zone');
    expect(run('backup', '--type', 'weekly').status).toBe(2);
  });
});

const version = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
const [major = 0, minor = 0] = (version.status === 0 ? version.stdout.trim().replace(/^v/, '') : '0.0').split('.').map(Number);
const hasCompose = version.status === 0 && (major > 2 || (major === 2 && minor >= 24));

interface Service {
  build?: { context?: string };
  image?: string;
  environment?: Record<string, string>;
}

describe.skipIf(!hasCompose)('compose.wal.yml', { timeout: 60_000 }, () => {
  const settings = {
    BACKUP_S3_BUCKET: 'bucket-ref',
    BACKUP_S3_ACCESS_KEY_ID: 'key-id-ref',
    BACKUP_S3_SECRET_ACCESS_KEY: 'key-secret-ref',
    WAL_ENCRYPTION_KEY: 'encryption-key-ref',
    WAL_S3_ENDPOINT: 's3.storage.example',
  };
  const config = (env: Record<string, string | undefined>) =>
    spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'tools/backup/compose.wal.yml', '--profile', 'prober', 'config', '--format', 'json'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, COMPOSE_FILE: '', COMPOSE_PROFILES: '', ...env },
    });
  const services = (env: Record<string, string | undefined>) => (JSON.parse(config(env).stdout) as { services: Record<string, Service> }).services;

  it('gives db the bucket, the encryption and the retention, and builds the image from tools/wal', () => {
    const db = services(settings)['db'];
    expect(db?.image).toBe('crove-db:local');
    expect(db?.build?.context?.replaceAll('\\', '/')).toMatch(/\/tools\/wal$/);
    expect(db?.environment).toMatchObject({
      PGBACKREST_STANZA: 'crove',
      PGBACKREST_REPO1_TYPE: 's3',
      PGBACKREST_REPO1_S3_BUCKET: 'bucket-ref',
      PGBACKREST_REPO1_S3_ENDPOINT: 's3.storage.example',
      PGBACKREST_REPO1_STORAGE_PORT: '443',
      PGBACKREST_REPO1_S3_URI_STYLE: 'host',
      PGBACKREST_REPO1_STORAGE_VERIFY_TLS: 'y',
      PGBACKREST_REPO1_PATH: '/crove/wal',
      PGBACKREST_REPO1_CIPHER_TYPE: 'aes-256-cbc',
      PGBACKREST_REPO1_CIPHER_PASS: 'encryption-key-ref',
      PGBACKREST_REPO1_RETENTION_FULL: '4',
    });
    expect(services(settings)['prober']?.environment?.['PROBER_MAX_WAL_ARCHIVE_AGE_SECONDS']).toBe('600');
  });

  it('follows the prefix and the TLS and style settings', () => {
    const env = services({ ...settings, BACKUP_S3_PREFIX: 'books', WAL_S3_URI_STYLE: 'path', WAL_S3_PORT: '9000', WAL_S3_VERIFY_TLS: 'n' })['db']?.environment;
    expect(env).toMatchObject({ PGBACKREST_REPO1_PATH: '/books/wal', PGBACKREST_REPO1_S3_URI_STYLE: 'path', PGBACKREST_REPO1_STORAGE_PORT: '9000', PGBACKREST_REPO1_STORAGE_VERIFY_TLS: 'n' });
  });

  it('does not load without the bucket, its keys, the host and the encryption key, naming each setting', () => {
    for (const name of Object.keys(settings)) {
      const result = config({ ...settings, [name]: '' });
      expect(result.status, name).not.toBe(0);
      expect(result.stderr, name).toContain(`set ${name}`);
    }
  });
});
