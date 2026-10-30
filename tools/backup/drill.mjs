#!/usr/bin/env node
// Restore drill (issues #307, #351): proves that a backup made by tools/backup/backup.sh restores onto a fresh stack,
// and times it. Runbook: docs/runbooks/backup-and-restore.md ("Restore drill"). CI runs the s3 variant (ci.yml,
// "Backup and restore drill").
//   1. builds the images (tagged :<prefix>, so no other stack's images change) and starts a throwaway MinIO as the
//      backup target ("the second location"), on its own Docker network;
//   2. starts a source stack (compose project <prefix>-src), signs up, creates an org, uploads three synthetic
//      e-invoices, waits until the worker reads them into proposals and approves one into the journal; a second org
//      is offboarded, so the worker exports it;
//   3. runs backup.sh with an impossible setting first and with a missing one (each must exit 1 and alert through the
//      prober), then for real: a dump and a file copy, sealed with a throwaway BACKUP_ENCRYPTION_KEY (unless
//      --seal off) and uploaded to the target bucket, where a stray blob in the blob store must wait for the next prune;
//      then a fourth invoice and a second backup, which must upload only the new blob, link the old ones to the first
//      run and delete the stray one; then a journal voucher (NVK00001) is posted and the worker archives it in the WORM
//      archive (#2007), which both stacks share on a volume of the drill's own, as a deployment's archive outlives its
//      database;
//   4. wipes the source stack and its volumes, and deletes the local copies of the runs;
//   5. checks that restore.sh refuses a STORAGE that differs from the scratch stack's, a run with a file its
//      checksums do not list and (sealing on) an unsealed run in the bucket, then runs restore.sh s3:latest onto a scratch stack (<prefix>-restore) with empty
//      volumes and an empty bucket;
//   6. checks that the restore's WORM archive check names the journal voucher posted after the backup (its entry, the
//      voucher and its number allocation) and raised the NVK series above it; signs in as the same user, finds the
//      org, the four files with their bytes (read back through the API, so through the recorded object versions), the
//      journal entry and the second org's export (downloaded, so its record points at the restored object versions),
//      uploads one more invoice, which the worker reads (the restored stack takes writes), and posts a journal voucher
//      that takes NVK00002, above the archived NVK00001;
//   7. tears everything down (containers, volumes, networks, the images, the temporary directory).
// No AI endpoint: e-invoice XML is read without AI. Plain Node (26+), no dependencies; needs docker and bash.
//
//   node tools/backup/drill.mjs [--storage s3|local] [--restore-storage s3|local] [--seal on|off] [--keep]
// --storage s3 (default) runs the stack of docker-compose.split.yml (api and worker, files in MinIO), like a pilot
// on an S3-compatible bucket; local runs the all-in-one stack with the files volume. --restore-storage (default: the
// same) picks the scratch stack's; local adds tools/backup/scratch.compose.yml, as the monthly restore test does.
// --seal off uploads the runs unsealed. --keep leaves everything running for a look (tear down with
// `docker compose -p <project> down -v`).
// Environment: DRILL_PREFIX (default crove-drill; names the compose projects, the target, its network and the image
// tag, so two drills on one machine stay apart), DRILL_SRC_PORT (default 18181), DRILL_RESTORE_PORT (18182),
// DRILL_BASH (default bash).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyId, parseKey, sealFile } from './seal.mjs';

// Forward slashes throughout: these paths reach bash, where a backslash is an escape.
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const STORAGE = option('--storage', 's3');
const RESTORE_STORAGE = option('--restore-storage', STORAGE);
const SEAL = option('--seal', 'on');
const KEEP = args.includes('--keep');
if (!['s3', 'local'].includes(STORAGE) || !['s3', 'local'].includes(RESTORE_STORAGE)) throw new Error('--storage and --restore-storage are s3 or local');
if (!['on', 'off'].includes(SEAL)) throw new Error('--seal is on or off');
const PREFIX = process.env.DRILL_PREFIX ?? 'crove-drill';
if (!/^[a-z][a-z0-9-]{0,30}$/.test(PREFIX)) throw new Error('DRILL_PREFIX is lower-case letters, digits and -');
const TAG = PREFIX;
const BASH = process.env.DRILL_BASH ?? 'bash';
const MC_IMAGE = 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372';
const TARGET = { name: `${PREFIX}-backup-s3`, network: `${PREFIX}-backup-net`, user: 'crove-drill', secret: 'crove-drill-backup-secret', bucket: 'crove-backups' };
// The WORM archive both stacks use (#2007): a volume of its own, which wiping the source stack keeps.
const ARCHIVE_VOLUME = `${PREFIX}-archive`;
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

const work = mkdtempSync(join(tmpdir(), `${PREFIX}-`)).replaceAll('\\', '/');
const backupDir = `${work}/backups`;

// A stack: s3 is docker-compose.split.yml (api and worker, files in MinIO), local the all-in-one stack with the files
// volume; a local restore target also gets tools/backup/scratch.compose.yml, as the monthly restore test does. Each
// gets an override with image tags of its own and no published Mailpit port, so a stack already running on this
// machine is untouched. The service that writes the WORM archive (the worker, or the all-in-one crove) keeps it in
// read-only files on the drill's archive volume, with the shortest lag, so a posting is archived within two minutes.
function stack(name, port, storage, scratch) {
  const split = storage === 's3';
  const override = `${work}/${name}.compose.yml`;
  const services = ['migrate', 'auth-grants', 'crove', 'prober', ...(split ? ['api', 'worker'] : [])];
  const archiver = split ? 'worker' : 'crove';
  writeFileSync(
    override,
    [
      'services:',
      ...services.flatMap((s) => [
        `  ${s}:`,
        `    image: crove:${TAG}`,
        ...(s === archiver
          ? ['    environment:', '      ARCHIVE_STORE: local', "      ARCHIVE_LAG_SECONDS: '60'", '    volumes:', '      - archive:/data/archive']
          : []),
      ]),
      '  crove-extract:',
      `    image: crove-extract:${TAG}`,
      '  mailpit:',
      '    ports: !reset []',
      'volumes:',
      '  archive:',
      `    name: ${ARCHIVE_VOLUME}`,
      '    external: true',
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
  return { project: `${PREFIX}-${name}`, port, storage, files, storageEnv, archiver };
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
    // The seed approves a proposal and offboards an org without enrolling MFA; off is accepted on localhost only.
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
  // A throwaway key: what the bucket holds is sealed, and only this drill can open it.
  BACKUP_ENCRYPTION_KEY: SEAL === 'on' ? randomBytes(32).toString('base64') : '',
};

const docker = (argv, options = {}) => execFileSync('docker', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const compose = (stack, argv) => docker(['compose', ...argv], { env: stackEnv(stack), stdio: ['ignore', 'pipe', 'inherit'] });
// The MinIO client inside the target container (its alias `local` is the target itself).
const targetMc = (argv, options = {}) => docker(['exec', TARGET.name, 'mc', ...argv], options);
// Puts an object into the target bucket under the default prefix (crove/).
function putObject(key, bytes) {
  writeFileSync(`${work}/object`, bytes);
  docker(['cp', `${work}/object`, `${TARGET.name}:/tmp/object`]);
  targetMc(['cp', '--quiet', '/tmp/object', `local/${TARGET.bucket}/crove/${key}`]);
}
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

// fetch, tried again on a network error (a pooled connection the server closed while idle answers `fetch failed`).
// Every request the drill retries is safe to repeat: reads, sign-in, and uploads of content-addressed files.
async function send(url, makeInit) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, makeInit());
    } catch (error) {
      const cause = error?.cause?.code ?? error?.cause?.message;
      if (!(error instanceof TypeError) || attempt === 3) throw new Error(`${url}: ${error.message}${cause ? ` (${cause})` : ''}`);
      log(`${url}: ${error.message}${cause ? ` (${cause})` : ''}; trying again`);
      await sleep(1_000);
    }
  }
}
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
  // Commands carry an idempotency key, so a repeat after a network error is safe.
  const response = await send(`${base(stack)}/api/rpc/${path}`, () => ({
    method: 'POST',
    headers,
    body: JSON.stringify(input === undefined ? {} : { json: input }),
    signal: AbortSignal.timeout(REQUEST_MS),
  }));
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`rpc ${path}: HTTP ${response.status} ${JSON.stringify(body?.json ?? body)}`);
  return body.json;
}

async function auth(stack, path, body) {
  const response = await send(`${base(stack)}/auth/v1/${path}`, () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_MS),
  }));
  const json = await response.json();
  assert(response.ok && typeof json.access_token === 'string', `${path} returns a session (HTTP ${response.status})`);
  return json.access_token;
}

async function upload(stack, token, slug, name, bytes) {
  const response = await send(`${base(stack)}/api/files`, () => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/xml' }), name);
    return { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug }, body: form, signal: AbortSignal.timeout(REQUEST_MS) };
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

async function download(stack, token, slug, path) {
  const response = await send(`${base(stack)}${path}`, () => ({
    headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug },
    signal: AbortSignal.timeout(REQUEST_MS),
  }));
  assert(response.ok, `${path} downloads (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

function startTarget() {
  quietly(() => docker(['volume', 'rm', '-f', ARCHIVE_VOLUME]));
  docker(['volume', 'create', ARCHIVE_VOLUME]);
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
  // The drill's invoice carries no real digital signature, so its approval confirms the unverified signature (#674).
  const approved = await rpc(
    SRC,
    token,
    'inbox/approve',
    { id: proposals[0], revision: detail.revision, acceptUnverifiedSignature: true, idempotencyKey: randomUUID() },
    org.slug,
  );
  assert(typeof approved.journalEntryId === 'string', 'the approval posts a journal entry');
  const journal = await rpc(SRC, token, 'journal/list', {}, org.slug);
  assert(journal.length === 1, `one journal entry (found ${journal.length})`);
  // A second org, offboarded: the worker exports it, and the restore must keep that export downloadable.
  const leaving = await rpc(SRC, token, 'org/create', { name: 'Công ty Diễn tập Xuất dữ liệu', idempotencyKey: randomUUID() });
  await rpc(SRC, token, 'org/offboard', { confirmSlug: leaving.slug, idempotencyKey: randomUUID() }, leaving.slug);
  const exported = await waitFor('the offboarded org to be exported', 120_000, async () => {
    const view = await rpc(SRC, token, 'org/export', undefined, leaving.slug);
    if (!view.export) throw new Error('not exported yet');
    return view.export;
  });
  const manifest = await download(SRC, token, leaving.slug, '/api/org-export/manifest');
  log(`seeded: user ${email}, org ${org.slug}, ${fileIds.length} e-invoices, proposal ${proposals[0]} approved into entry ${approved.journalEntryId}; org ${leaving.slug} offboarded and exported (${exported.tables.length} tables)`);
  return {
    email,
    password,
    token,
    slug: org.slug,
    orgId: org.orgId,
    files: fileIds.map((id, i) => ({ id, bytes: invoices[i] })),
    entryId: approved.journalEntryId,
    exported: { slug: leaving.slug, manifestSha256: sha256(manifest) },
  };
}

// A journal voucher posted through its proposal, approved by the owner (the org's only member, so four-eyes gives way
// to the owner override). Returns the voucher, its entry and the entry's description, which starts with the voucher's
// code (NVK00001 ...).
async function journalVoucher(stack, token, slug, description) {
  const asked = await rpc(
    stack,
    token,
    'inbox/request',
    {
      command: 'finance.journal_voucher.record',
      input: {
        date: new Date().toISOString().slice(0, 10),
        description,
        lines: [
          { account: '6422', debit: '150000', credit: '0' },
          { account: '1111', debit: '0', credit: '150000' },
        ],
      },
      idempotencyKey: randomUUID(),
    },
    slug,
  );
  const detail = await rpc(stack, token, 'inbox/get', { id: asked.proposalId }, slug);
  assert(detail.canApprove, `the journal voucher can be approved (${detail.approveReason})`);
  const approved = await rpc(stack, token, 'inbox/approve', { id: asked.proposalId, revision: detail.revision, idempotencyKey: randomUUID() }, slug);
  assert(typeof approved.voucherId === 'string', 'the approval records a journal voucher');
  const entry = await rpc(stack, token, 'journal/get', { id: approved.journalEntryId }, slug);
  return { voucherId: approved.voucherId, entryId: approved.journalEntryId, description: entry.description };
}

// Waits until a batch of the WORM archive names `ref`, read in the stack's archiving container.
async function archived(stack, ref) {
  await waitFor(`${ref} in the WORM archive`, 300_000, async () => {
    const found = compose(stack, ['exec', '-T', stack.archiver, 'sh', '-c', `grep -l -F '"${ref}"' /data/archive/chain/v1/*.json 2>/dev/null || true`]);
    if (!found.trim()) throw new Error('not archived yet');
    return found.trim();
  });
}

// The figures of a backup's log: blobs uploaded, already in the store, linked to the previous run, deleted strays.
function backupFigures(output) {
  const uploaded = /(\d+) new blob\(s\) into (blobs\/\S+), (\d+) already there/.exec(output);
  const shared = /files: (\d+) blob\(s\), [^;]+; (\d+) shared with the previous run/.exec(output);
  const pruned = /blob stores: (\d+) blob\(s\) listed by kept runs, (\d+) deleted, (\d+) unlisted/.exec(output);
  assert(uploaded && shared && pruned, 'the backup log reports uploaded, shared and pruned blobs');
  return { newBlobs: Number(uploaded[1]), store: uploaded[2], already: Number(uploaded[3]), blobs: Number(shared[1]), linked: Number(shared[2]), deleted: Number(pruned[2]), unlisted: Number(pruned[3]) };
}

async function verifyRestored(seeded) {
  const token = await auth(DST, 'token?grant_type=password', { email: seeded.email, password: seeded.password });
  const me = await rpc(DST, token, 'me/get');
  assert(me.orgs.some((o) => o.slug === seeded.slug && o.orgId === seeded.orgId && o.role === 'owner'), `the org ${seeded.slug} is back, with its owner`);
  const recent = await rpc(DST, token, 'files/recent', undefined, seeded.slug);
  for (const { id, bytes } of seeded.files) {
    assert(recent.some((f) => f.id === id), `file ${id} is listed`);
    const got = await download(DST, token, seeded.slug, `/api/files/${id}`);
    assert(sha256(got) === sha256(bytes), `file ${id} reads back with its sha256`);
  }
  const journal = await rpc(DST, token, 'journal/list', {}, seeded.slug);
  assert(journal.length === 1 && journal[0].id === seeded.entryId, `the journal entry ${seeded.entryId} is back`);
  const manifest = await download(DST, token, seeded.exported.slug, '/api/org-export/manifest');
  assert(sha256(manifest) === seeded.exported.manifestSha256, `the export of ${seeded.exported.slug} downloads with the same manifest`);
  log(`restored data: signed in as ${seeded.email}, org, ${seeded.files.length} files with their bytes, the journal entry and the second org's export are back`);
  // The journal voucher posted after the backup is lost, and its number with it; the restore raised the series, so the
  // next voucher takes the number after the archived one.
  const next = await journalVoucher(DST, token, seeded.slug, 'Diễn tập sau khôi phục');
  assert(next.description.startsWith('NVK00002 '), `the next journal voucher takes NVK00002, above the archived NVK00001 (${next.description})`);
  log('numbering: the next journal voucher took NVK00002, above NVK00001, which the WORM archive holds and the restore lost');
  const more = await upload(DST, token, seeded.slug, 'hoadon-4106.xml', invoice(4106));
  await proposalOf(DST, token, seeded.slug, more);
  log('restored stack takes writes: one more e-invoice was uploaded and read into a proposal');
}

function teardown() {
  if (KEEP) {
    log(`--keep: left ${SRC.project}, ${DST.project}, ${TARGET.name} and ${work} in place`);
    return;
  }
  for (const stack of [SRC, DST]) quietly(() => compose(stack, ['down', '-v', '--remove-orphans']));
  quietly(() => docker(['rm', '-f', TARGET.name]));
  quietly(() => docker(['network', 'rm', TARGET.network]));
  quietly(() => docker(['volume', 'rm', '-f', ARCHIVE_VOLUME]));
  quietly(() => docker(['image', 'rm', `crove:${TAG}`, `crove-extract:${TAG}`]));
  rmSync(work, { recursive: true, force: true });
  log('torn down: both stacks with their volumes and networks, the backup target, the images and the work directory');
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
  log(`backup from ${STORAGE} storage, restore onto ${RESTORE_STORAGE} storage, sealing ${SEAL}, prefix ${PREFIX}, work directory ${work}`);
  await time('build images', () => compose(SRC, ['build', '--quiet']));
  startTarget();
  await waitFor('the backup target', 60_000, async () => targetMc(['mb', '--ignore-existing', `local/${TARGET.bucket}`]));

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

  // A stray object in the blob store that no run lists: the first prune notes it, the second deletes it.
  const store = SEAL === 'on' ? `blobs/k${keyId(parseKey(targetEnv.BACKUP_ENCRYPTION_KEY)).toString('hex')}` : 'blobs/plain';
  const stray = `${store}/org/00000000-0000-4000-8000-000000000000/${'0'.repeat(64)}`;
  putObject(stray, Buffer.from('stray'));

  const first = await time('backup', async () => script('backup.sh', SRC, {}));
  assert(first.status === 0, `backup.sh exits 0 (got ${first.status})`);
  const one = backupFigures(first.output);
  assert(one.store === store, `the run uses blob store ${store} (${one.store})`);
  // Org blobs (the invoices) go to the shared store; other files (the export's parts) travel with the run.
  assert(one.newBlobs >= seeded.files.length && one.already === 0, `the first run uploads every org blob (${one.newBlobs})`);
  assert(one.deleted === 0 && one.unlisted === 1, `the stray blob waits a run (${one.deleted} deleted, ${one.unlisted} unlisted)`);
  assert(readFileSync(`${backupDir}/last-success`, 'utf8').includes(`ENCRYPTION=${SEAL === 'on' ? 'aes-256-gcm' : 'none'}`), 'last-success names the run');
  if (SEAL === 'on') {
    // Nothing readable in the bucket: run files are sealed (.enc), and neither the roles nor an invoice show.
    const objects = targetMc(['ls', '--recursive', `local/${TARGET.bucket}/crove/`]);
    const runFiles = objects.split('\n').filter((l) => /\d{8}T\d{6}Z\//.test(l));
    assert(runFiles.length > 0 && runFiles.every((l) => l.trim().endsWith('.enc')), 'every run file in the bucket is sealed');
    const runId = /run (\d{8}T\d{6}Z) into/.exec(first.output)[1];
    const roles = targetMc(['cat', `local/${TARGET.bucket}/crove/${runId}/roles.sql.enc`], { encoding: 'latin1' });
    assert(roles.startsWith('CRB1') && !roles.includes('CREATE ROLE'), 'roles.sql is sealed in the bucket');
    const blob = targetMc(['cat', `local/${TARGET.bucket}/crove/${one.store}/org/${seeded.orgId}/${sha256(seeded.files[0].bytes)}`], { encoding: 'latin1' });
    assert(blob.startsWith('CRB1') && !blob.includes('SHDon'), 'an invoice blob is sealed in the bucket');
    log('sealed: every run file and blob in the bucket is CRB1, with no plaintext roles or invoice');
  }

  // A fourth invoice: the next run uploads only its blob, links the others to the first run, and deletes the stray one.
  const fourth = invoice(4105);
  const fourthId = await upload(SRC, seeded.token, seeded.slug, 'hoadon-4105.xml', fourth);
  await proposalOf(SRC, seeded.token, seeded.slug, fourthId);
  seeded.files.push({ id: fourthId, bytes: fourth });
  const second = await time('second backup (incremental)', async () => script('backup.sh', SRC, {}));
  assert(second.status === 0, `the second backup exits 0 (got ${second.status})`);
  const two = backupFigures(second.output);
  assert(two.store === one.store, 'both runs use the same blob store');
  assert(two.newBlobs >= 1 && two.already === one.newBlobs, `the second run uploads only new blobs (${two.newBlobs} new, ${two.already} already there)`);
  assert(two.linked >= one.newBlobs, `the second run links the first run's org blobs (${two.linked} of ${one.newBlobs})`);
  assert(two.deleted === 1 && two.unlisted === 0, `the stray blob is deleted (${two.deleted} deleted, ${two.unlisted} unlisted)`);
  let strayGone = false;
  try {
    targetMc(['stat', `local/${TARGET.bucket}/crove/${stray}`]);
  } catch {
    strayGone = true;
  }
  assert(strayGone, 'the stray blob is gone from the bucket');
  log(`incremental: ${two.newBlobs} new blob(s) uploaded, ${two.already} already there, ${two.linked} linked to the first run, the stray blob deleted on the second prune`);

  // After the last backup: a journal voucher, numbered NVK00001, which the worker archives (#2007). The restore loses
  // it; the archive keeps it, and the restore's archive check must name it and raise the series above its number.
  const late = await journalVoucher(SRC, seeded.token, seeded.slug, 'Diễn tập sau bản sao lưu');
  assert(late.description.startsWith('NVK00001 '), `the voucher after the backup is NVK00001 (${late.description})`);
  await time('archive the voucher posted after the backup', () => archived(SRC, `journal:${seeded.orgId}:${late.entryId}`));
  log(`after the backup: journal voucher ${late.voucherId} (NVK00001), entry ${late.entryId}, archived in the WORM archive`);

  await time('wipe source', async () => {
    compose(SRC, ['down', '-v', '--remove-orphans']);
    rmSync(backupDir, { recursive: true, force: true });
  });
  log('source stack, its volumes and the local copies of the backups are gone; only the backup bucket is left');

  // A STORAGE that differs from the target stack's would write the blobs where the target does not read them (the
  // production bucket, for a scratch stack): restore.sh refuses before it touches anything.
  const wrongStorage = DST.storage === 's3' ? 'local' : 's3';
  const refused = script('restore.sh', DST, { STORAGE: wrongStorage, S3_BUCKET: 'crove-files' }, ['s3:latest']);
  assert(refused.status === 1, `restore.sh with STORAGE=${wrongStorage} exits 1 (got ${refused.status})`);
  assert(refused.output.includes(`the target compose project uses STORAGE=${DST.storage}`), 'restore.sh names the storage mismatch');
  log(`refused: restore.sh with STORAGE=${wrongStorage} onto a STORAGE=${DST.storage} stack`);
  // A file the run's checksums do not list is refused too: a stray blob in the run's directory (sealed with the run's
  // key when the run is sealed, so it opens and only the listing catches it).
  const latest = /run (\d{8}T\d{6}Z) into/.exec(second.output)[1];
  const extraPath = `files/org/${seeded.orgId}/${'1'.repeat(64)}`;
  const extra = `${latest}/${extraPath}${SEAL === 'on' ? '.enc' : ''}`;
  if (SEAL === 'on') {
    writeFileSync(`${work}/extra.plain`, 'stray');
    sealFile(`${work}/extra.plain`, `${work}/extra.sealed`, `${latest}/${extraPath}`, parseKey(targetEnv.BACKUP_ENCRYPTION_KEY));
    putObject(extra, readFileSync(`${work}/extra.sealed`));
  } else {
    putObject(extra, Buffer.from('stray'));
  }
  const unlisted = script('restore.sh', DST, DST.storage === 's3' ? { RESTORE_PRESTART: 'db minio' } : {}, ['s3:latest']);
  targetMc(['rm', '--quiet', `local/${TARGET.bucket}/crove/${extra}`]);
  assert(unlisted.status === 1, `restore.sh with an unlisted file exits 1 (got ${unlisted.status})`);
  assert(unlisted.output.includes('neither SHA256SUMS nor files.sha256 lists'), 'restore.sh names the unlisted file');
  log('refused: a run with a file its checksums do not list');
  if (SEAL === 'on') {
    // An unsealed run in the bucket of a deployment that seals may come from whoever holds the bucket's keys alone.
    const forged = '29991231T000000Z';
    putObject(`${forged}/SHA256SUMS`, Buffer.from('forged\n'));
    const downgrade = script('restore.sh', DST, DST.storage === 's3' ? { RESTORE_PRESTART: 'db minio' } : {}, ['s3:latest']);
    targetMc(['rm', '--quiet', '--recursive', '--force', `local/${TARGET.bucket}/crove/${forged}/`]);
    assert(downgrade.status === 1, `restore.sh of an unsealed run with a key set exits 1 (got ${downgrade.status})`);
    assert(downgrade.output.includes('is not sealed although BACKUP_ENCRYPTION_KEY is set'), 'restore.sh names the unsealed run');
    log('refused: an unsealed run in the bucket while BACKUP_ENCRYPTION_KEY is set');
  }

  const restore = await time('restore (restore.sh s3:latest, until /readyz is green)', async () =>
    script('restore.sh', DST, DST.storage === 's3' ? { RESTORE_PRESTART: 'db minio', RESTORE_SAMPLE: '0' } : { RESTORE_SAMPLE: '0' }, ['s3:latest']),
  );
  assert(restore.status === 0, `restore.sh exits 0 (got ${restore.status})`);
  assert(restore.output.includes(`restore of ${latest} passed`), `the newest run ${latest} was restored`);
  // The downloaded copy of the run (the whole database in plain text) is gone; the restore log and lists stay.
  const restoreDirs = readdirSync(backupDir).filter((name) => name.startsWith('restore-'));
  const passed = restoreDirs.filter((name) => readdirSync(`${backupDir}/${name}`).includes('counts.restored.tsv'));
  assert(passed.length === 1, `one restore directory with its lists (found ${restoreDirs.join(', ')})`);
  const leftover = readdirSync(`${backupDir}/${passed[0]}`).filter((name) => /^\d{8}T\d{6}Z$/.test(name));
  assert(leftover.length === 0, `no downloaded run left after the restore (found ${leftover.join(', ')})`);
  // The WORM archive check (#2007): the voucher posted after the backup, its entry and its number allocation are named
  // as lost, and the NVK series was raised above the archived NVK00001.
  assert(restore.output.includes('WARNING: the WORM archive holds rows made after the backup point'), 'the restore warns that the archive holds rows it lost');
  const report = JSON.parse(readFileSync(`${backupDir}/${passed[0]}/archive-report.json`, 'utf8'));
  const lost = report.orgs.find((o) => o.orgId === seeded.orgId);
  assert(lost?.journalEntries.includes(late.entryId), `the archive report names the entry ${late.entryId} as lost`);
  assert(lost?.journalVouchers.includes(late.voucherId), `the archive report names the journal voucher ${late.voucherId} as lost`);
  assert(lost?.allocations.length >= 1, 'the archive report names the voucher\'s number allocation as lost');
  const raised = report.reseeded.find((r) => r.orgId === seeded.orgId && r.docType === 'finance.journal_voucher');
  assert(raised?.archivedHigh === '1', `the NVK series was raised above the archived number 1 (${JSON.stringify(raised)})`);
  assert(report.problems.length === 0 && report.needFloor.length === 0, `the archive matches the restored database (${JSON.stringify(report.problems)})`);
  // The lost rows are acknowledged in the archive (#2020), so the nightly verification excuses them and nothing else.
  assert(typeof report.acknowledged === 'string' && report.acknowledged.startsWith('restores/v1/'), `the restore is acknowledged (${report.acknowledged})`);
  assert(report.lostRefs.some(([, ref]) => ref === `journal:${seeded.orgId}:${late.entryId}`), 'the acknowledgement names the lost entry');
  log(`archive check: ${report.beyond.length} batch(es) after the backup point; the entry, the voucher and ${lost.allocations.length} number allocation(s) named as lost; the NVK series raised above 1`);
  await time('verify through the API', async () => {
    await ready(DST);
    await verifyRestored(seeded);
  });

  const rto = timings['restore (restore.sh s3:latest, until /readyz is green)'] + timings['verify through the API'];
  console.log('\n[drill] timings (seconds):');
  for (const [name, seconds] of Object.entries(timings)) console.log(`  ${name.padEnd(56)} ${seconds.toFixed(1)}`);
  console.log(`  ${'restore and verify (the RTO part)'.padEnd(56)} ${rto.toFixed(1)}`);
  log(`passed (${STORAGE} to ${RESTORE_STORAGE}, sealing ${SEAL})`);
}

main()
  .catch((error) => {
    console.error(`[drill] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(teardown);
