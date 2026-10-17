#!/usr/bin/env node
// Restore drill (issue #307): proves that a backup made by tools/backup/backup.sh restores onto a fresh stack, and
// times it. Runbook: docs/runbooks/backup-and-restore.md ("Restore drill").
//   1. builds the images (tagged :drill, so no other stack's images change) and starts a throwaway MinIO as the
//      backup target ("the second location"), on its own Docker network;
//   2. starts a source stack (compose project crove-drill-src), signs up, creates an org, uploads three synthetic
//      e-invoices, waits until the worker reads them into proposals and approves one into the journal;
//   3. runs backup.sh with an impossible setting first (it must exit 1 and alert through the prober), then for real:
//      a dump and a file copy, uploaded to the target bucket;
//   4. wipes the source stack and its volumes, and deletes the local copy of the run;
//   5. runs restore.sh s3:latest onto a scratch stack (crove-drill-restore) with empty volumes and an empty bucket;
//   6. signs in as the same user, finds the org, the three files with their bytes (read back through the API, so
//      through the recorded object versions) and the journal entry, and uploads a fourth invoice, which the worker
//      reads (the restored stack takes writes);
//   7. tears everything down (containers, volumes, networks, the :drill images, the temporary directory).
// No AI endpoint: e-invoice XML is read without AI. Plain Node (26+), no dependencies; needs docker and bash.
//
//   node tools/backup/drill.mjs [--storage s3|local] [--restore-storage s3|local] [--keep]
// --storage s3 (default) runs the stack of docker-compose.split.yml (api and worker, files in MinIO), like a pilot
// on an S3-compatible bucket; local runs the all-in-one stack with the files volume. --restore-storage (default: the
// same) picks the scratch stack's; local adds tools/backup/scratch.compose.yml, as the monthly restore test does.
// --keep leaves everything running for a look (tear down with `docker compose -p <project> down -v`).
// Environment: DRILL_SRC_PORT (default 18181), DRILL_RESTORE_PORT (18182), DRILL_BASH (default bash).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Forward slashes throughout: these paths reach bash, where a backslash is an escape.
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const STORAGE = option('--storage', 's3');
const RESTORE_STORAGE = option('--restore-storage', STORAGE);
const KEEP = args.includes('--keep');
if (!['s3', 'local'].includes(STORAGE) || !['s3', 'local'].includes(RESTORE_STORAGE)) throw new Error('--storage and --restore-storage are s3 or local');
const BASH = process.env.DRILL_BASH ?? 'bash';
const MC_IMAGE = 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372';
const TARGET = { name: 'crove-drill-backup-s3', network: 'crove-drill-backup-net', user: 'crove-drill', secret: 'crove-drill-backup-secret', bucket: 'crove-backups' };
const INVOICE = readFileSync(`${ROOT}apps/extract/test/fixtures/einvoice-basic.xml`, 'utf8');
const invoice = (number) => Buffer.from(INVOICE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`), 'utf8');
const REQUEST_MS = 15_000;

const started = Date.now();
const log = (message) => console.log(`[drill +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const work = mkdtempSync(join(tmpdir(), 'crove-drill-')).replaceAll('\\', '/');
const backupDir = `${work}/backups`;

// A stack: s3 is docker-compose.split.yml (api and worker, files in MinIO), local the all-in-one stack with the files
// volume; a local restore target also gets tools/backup/scratch.compose.yml, as the monthly restore test does. Each
// gets an override with image tags of its own and no published Mailpit port, so a stack already running on this
// machine is untouched.
function stack(name, port, storage, scratch) {
  const split = storage === 's3';
  const override = `${work}/${name}.compose.yml`;
  const services = ['migrate', 'auth-grants', 'crove', 'prober', ...(split ? ['api', 'worker'] : [])];
  writeFileSync(
    override,
    [
      'services:',
      ...services.flatMap((s) => [`  ${s}:`, '    image: crove:drill']),
      '  crove-extract:',
      '    image: crove-extract:drill',
      '  mailpit:',
      '    ports: !reset []',
      '',
    ].join('\n'),
  );
  const files = [
    `${ROOT}docker-compose.yml`,
    ...(split ? [`${ROOT}docker-compose.split.yml`] : []),
    ...(scratch && !split ? [`${ROOT}tools/backup/scratch.compose.yml`] : []),
    override,
  ];
  // The storage settings backup.sh and restore.sh read: the values docker-compose.split.yml gives the stack.
  const storageEnv = split
    ? { STORAGE: 's3', S3_ENDPOINT: 'http://minio:9000', S3_BUCKET: 'crove-files', S3_ACCESS_KEY_ID: 'crove-split', S3_SECRET_ACCESS_KEY: 'crove-split-minio-secret', S3_FORCE_PATH_STYLE: 'true', S3_VERSIONING: 'required' }
    : { STORAGE: 'local' };
  return { project: `crove-drill-${name}`, port, storage, files, storageEnv };
}
const SRC = stack('src', process.env.DRILL_SRC_PORT ?? '18181', STORAGE, false);
const DST = stack('restore', process.env.DRILL_RESTORE_PORT ?? '18182', RESTORE_STORAGE, true);

function stackEnv(stack) {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: stack.project,
    COMPOSE_FILE: stack.files.join(delimiter),
    PORT: stack.port,
    SPLIT_PORT: stack.port,
    PUBLIC_URL: `http://localhost:${stack.port}`,
    // The seed approves a proposal without enrolling MFA; off is accepted on localhost only.
    AUTH_STEP_UP: 'off',
    ...stack.storageEnv,
  };
}
const targetEnv = {
  BACKUP_DIR: backupDir,
  BACKUP_S3_ENDPOINT: `http://${TARGET.name}:9000`,
  BACKUP_S3_BUCKET: TARGET.bucket,
  BACKUP_S3_ACCESS_KEY_ID: TARGET.user,
  BACKUP_S3_SECRET_ACCESS_KEY: TARGET.secret,
  BACKUP_S3_NETWORK: TARGET.network,
};

const docker = (argv, options = {}) => execFileSync('docker', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const compose = (stack, argv) => docker(['compose', ...argv], { env: stackEnv(stack), stdio: ['ignore', 'pipe', 'inherit'] });
const quietly = (fn) => {
  try {
    fn();
  } catch {
    // teardown of something that is already gone
  }
};

// Runs a backup script; its output streams to this console. Returns the exit code and the output.
function script(name, stack, extraEnv, argv = []) {
  const result = spawnSync(BASH, [`${ROOT}tools/backup/${name}`, ...argv], {
    env: { ...stackEnv(stack), CROVE_DIR: ROOT, ...targetEnv, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe().catch((error) => ({ error }));
    if (last && !last.error) return last;
    if (last?.error?.fatal) throw last.error;
    await sleep(1_000);
  }
  throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}${last?.error ? `: ${last.error.message}` : ''}`);
}

const base = (stack) => `http://127.0.0.1:${stack.port}`;
async function ready(stack) {
  await waitFor(`${stack.project} to be ready`, 300_000, async () => {
    const response = await fetch(`${base(stack)}/readyz`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok || (await response.json()).ready !== true) throw new Error('not ready');
    const auth = await fetch(`${base(stack)}/auth/v1/health`, { signal: AbortSignal.timeout(5_000) });
    if (!auth.ok) throw new Error('Supabase Auth not answering');
    return true;
  });
}

async function rpc(stack, token, path, input, org) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (org) headers['x-crove-org'] = org;
  const response = await fetch(`${base(stack)}/api/rpc/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input === undefined ? {} : { json: input }),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`rpc ${path}: HTTP ${response.status} ${JSON.stringify(body?.json ?? body)}`);
  return body.json;
}

async function auth(stack, path, body) {
  const response = await fetch(`${base(stack)}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const json = await response.json();
  assert(response.ok && typeof json.access_token === 'string', `${path} returns a session (HTTP ${response.status})`);
  return json.access_token;
}

async function upload(stack, token, slug, name, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/xml' }), name);
  const response = await fetch(`${base(stack)}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug },
    body: form,
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const json = await response.json();
  assert(response.ok && json.files?.[0]?.fileId, `upload of ${name} accepted (HTTP ${response.status})`);
  return json.files[0].fileId;
}

async function proposalOf(stack, token, slug, fileId) {
  return waitFor(`file ${fileId} to be read into a proposal`, 120_000, async () => {
    const found = (await rpc(stack, token, 'files/recent', undefined, slug)).find((f) => f.id === fileId);
    if (found?.status === 'failed') throw Object.assign(new Error(`extraction failed: ${found.error}`), { fatal: true });
    if (found?.status !== 'proposed' || !found.proposalId) throw new Error(found ? found.status : 'not filed yet');
    return found.proposalId;
  });
}

async function download(stack, token, slug, fileId) {
  const response = await fetch(`${base(stack)}/api/files/${fileId}`, {
    headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug },
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  assert(response.ok, `file ${fileId} downloads (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

function startTarget() {
  quietly(() => docker(['rm', '-f', TARGET.name]));
  quietly(() => docker(['network', 'rm', TARGET.network]));
  docker(['network', 'create', TARGET.network]);
  docker([
    'run', '-d', '--name', TARGET.name, '--network', TARGET.network,
    '-e', `MINIO_ROOT_USER=${TARGET.user}`, '-e', `MINIO_ROOT_PASSWORD=${TARGET.secret}`,
    '-e', `MC_HOST_local=http://${TARGET.user}:${TARGET.secret}@127.0.0.1:9000`,
    MC_IMAGE, 'server', '/data',
  ]);
}

async function seed() {
  const email = `drill-${Date.now()}@example.com`;
  const password = 'restore-drill-password-0123';
  const token = await auth(SRC, 'signup', { email, password });
  const org = await rpc(SRC, token, 'org/create', { name: 'Công ty Diễn tập Khôi phục', idempotencyKey: randomUUID() });
  const invoices = [invoice(4101), invoice(4102), invoice(4103)];
  const fileIds = [];
  for (const [i, bytes] of invoices.entries()) fileIds.push(await upload(SRC, token, org.slug, `hoadon-${4101 + i}.xml`, bytes));
  const proposals = [];
  for (const id of fileIds) proposals.push(await proposalOf(SRC, token, org.slug, id));
  const detail = await rpc(SRC, token, 'inbox/get', { id: proposals[0] }, org.slug);
  assert(detail.canApprove, `the proposal can be approved (${detail.approveReason})`);
  const approved = await rpc(SRC, token, 'inbox/approve', { id: proposals[0], revision: detail.revision, idempotencyKey: randomUUID() }, org.slug);
  assert(typeof approved.journalEntryId === 'string', 'the approval posts a journal entry');
  const journal = await rpc(SRC, token, 'journal/list', {}, org.slug);
  assert(journal.length === 1, `one journal entry (found ${journal.length})`);
  log(`seeded: user ${email}, org ${org.slug}, ${fileIds.length} e-invoices, proposal ${proposals[0]} approved into entry ${approved.journalEntryId}`);
  return { email, password, slug: org.slug, orgId: org.orgId, files: fileIds.map((id, i) => ({ id, bytes: invoices[i] })), entryId: approved.journalEntryId };
}

async function verifyRestored(seeded) {
  const token = await auth(DST, 'token?grant_type=password', { email: seeded.email, password: seeded.password });
  const me = await rpc(DST, token, 'me/get');
  assert(me.orgs.some((o) => o.slug === seeded.slug && o.orgId === seeded.orgId && o.role === 'owner'), `the org ${seeded.slug} is back, with its owner`);
  const recent = await rpc(DST, token, 'files/recent', undefined, seeded.slug);
  for (const { id, bytes } of seeded.files) {
    assert(recent.some((f) => f.id === id), `file ${id} is listed`);
    const got = await download(DST, token, seeded.slug, id);
    assert(sha256(got) === sha256(bytes), `file ${id} reads back with its sha256`);
  }
  const journal = await rpc(DST, token, 'journal/list', {}, seeded.slug);
  assert(journal.length === 1 && journal[0].id === seeded.entryId, `the journal entry ${seeded.entryId} is back`);
  log(`restored data: signed in as ${seeded.email}, org, ${seeded.files.length} files with their bytes and the journal entry are back`);
  const fourth = await upload(DST, token, seeded.slug, 'hoadon-4104.xml', invoice(4104));
  await proposalOf(DST, token, seeded.slug, fourth);
  log('restored stack takes writes: a fourth e-invoice was uploaded and read into a proposal');
}

function teardown() {
  if (KEEP) {
    log(`--keep: left ${SRC.project}, ${DST.project}, ${TARGET.name} and ${work} in place`);
    return;
  }
  for (const stack of [SRC, DST]) quietly(() => compose(stack, ['down', '-v', '--remove-orphans']));
  quietly(() => docker(['rm', '-f', TARGET.name]));
  quietly(() => docker(['network', 'rm', TARGET.network]));
  quietly(() => docker(['image', 'rm', 'crove:drill', 'crove-extract:drill']));
  rmSync(work, { recursive: true, force: true });
  log('torn down: both stacks with their volumes and networks, the backup target, the :drill images and the work directory');
}

async function main() {
  const timings = {};
  const time = async (name, fn) => {
    const at = Date.now();
    const result = await fn();
    timings[name] = (Date.now() - at) / 1000;
    log(`${name}: ${timings[name].toFixed(1)} s`);
    return result;
  };
  log(`backup from ${STORAGE} storage, restore onto ${RESTORE_STORAGE} storage, work directory ${work}`);
  await time('build images', () => compose(SRC, ['build', '--quiet']));
  startTarget();
  await waitFor('the backup target', 60_000, async () => docker(['exec', TARGET.name, 'mc', 'mb', '--ignore-existing', `local/${TARGET.bucket}`]));

  await time('source stack start', async () => {
    compose(SRC, ['up', '-d']);
    await ready(SRC);
  });
  const seeded = await time('seed', seed);

  const broken = script('backup.sh', SRC, SRC.storage === 's3' ? { S3_BUCKET: 'no-such-bucket' } : { BACKUP_FILES_SERVICE: 'no-such-service' });
  assert(broken.status === 1, `a failing backup exits 1 (got ${broken.status})`);
  assert(/\[backup\] FAILED: file copy/.test(broken.output), 'a failing backup logs [backup] FAILED');
  assert(broken.output.includes('the backup failed.'), 'a failing backup alerts through the prober');
  log('failure path: backup.sh exited 1, logged [backup] FAILED and the prober printed the alert');
  // A missing setting fails before anything is dumped, through the same report and alert.
  const unset = script('backup.sh', SRC, { BACKUP_S3_BUCKET: '' });
  assert(unset.status === 1, `a backup without BACKUP_S3_BUCKET exits 1 (got ${unset.status})`);
  assert(unset.output.includes('[backup] FAILED: settings: BACKUP_S3_BUCKET is required'), 'a missing setting logs [backup] FAILED');
  assert(unset.output.includes('the backup failed.'), 'a missing setting alerts through the prober');
  log('failure path: a missing BACKUP_S3_BUCKET exited 1, logged [backup] FAILED and alerted');

  const backup = await time('backup', async () => script('backup.sh', SRC, {}));
  assert(backup.status === 0, `backup.sh exits 0 (got ${backup.status})`);

  await time('wipe source', async () => {
    compose(SRC, ['down', '-v', '--remove-orphans']);
    rmSync(backupDir, { recursive: true, force: true });
  });
  log('source stack, its volumes and the local copy of the backup are gone; only the backup bucket is left');

  // A STORAGE that differs from the target stack's would write the blobs where the target does not read them (the
  // production bucket, for a scratch stack): restore.sh refuses before it touches anything.
  const wrongStorage = DST.storage === 's3' ? 'local' : 's3';
  const refused = script('restore.sh', DST, { STORAGE: wrongStorage, S3_BUCKET: 'crove-files' }, ['s3:latest']);
  assert(refused.status === 1, `restore.sh with STORAGE=${wrongStorage} exits 1 (got ${refused.status})`);
  assert(refused.output.includes(`the target compose project uses STORAGE=${DST.storage}`), 'restore.sh names the storage mismatch');
  log(`refused: restore.sh with STORAGE=${wrongStorage} onto a STORAGE=${DST.storage} stack`);

  const restore = await time('restore (restore.sh s3:latest, until /readyz is green)', async () =>
    script('restore.sh', DST, DST.storage === 's3' ? { RESTORE_PRESTART: 'db minio', RESTORE_SAMPLE: '0' } : { RESTORE_SAMPLE: '0' }, ['s3:latest']),
  );
  assert(restore.status === 0, `restore.sh exits 0 (got ${restore.status})`);
  // The downloaded copy of the run (the whole database in plain text) is gone; the restore log and lists stay.
  const restoreDirs = readdirSync(backupDir).filter((name) => name.startsWith('restore-'));
  assert(restoreDirs.length === 1, `one restore directory (found ${restoreDirs.join(', ')})`);
  const leftover = readdirSync(`${backupDir}/${restoreDirs[0]}`).filter((name) => /^\d{8}T\d{6}Z$/.test(name));
  assert(leftover.length === 0, `no downloaded run left after the restore (found ${leftover.join(', ')})`);
  assert(readdirSync(`${backupDir}/${restoreDirs[0]}`).includes('counts.restored.tsv'), 'the restore directory keeps its lists');
  await time('verify through the API', async () => {
    await ready(DST);
    await verifyRestored(seeded);
  });

  const rto = timings['restore (restore.sh s3:latest, until /readyz is green)'] + timings['verify through the API'];
  console.log('\n[drill] timings (seconds):');
  for (const [name, seconds] of Object.entries(timings)) console.log(`  ${name.padEnd(56)} ${seconds.toFixed(1)}`);
  console.log(`  ${'restore and verify (the RTO part)'.padEnd(56)} ${rto.toFixed(1)}`);
  log(`passed (${STORAGE} to ${RESTORE_STORAGE})`);
}

main()
  .catch((error) => {
    console.error(`[drill] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(teardown);
