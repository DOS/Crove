#!/usr/bin/env node
// End-to-end run of the split stack (External-tenant gate T7, issue #108): `api` and `worker` as separate
// containers of the same image, STORAGE=s3 against MinIO, no shared files volume. Drives the real HTTP API of a
// stack started with docker-compose.split.yml (see the header of that file):
//   1. the topology: api and worker run, the all-in-one service does not, neither has a mount, only the worker is
//      on the extract network, and both log that they store blobs in the bucket;
//   2. sign up, create an org, upload the synthetic e-invoice; the worker extracts it into a proposal;
//   3. post an inbound email with a second invoice to the org's address; the worker files it and extracts it;
//   4. both files are objects in MinIO with the right bytes, the raw message was deleted from the bucket, and
//      nothing was written under /data/files in either container.
// No AI endpoint is configured: e-invoice XML is read without AI. Plain Node (26+), no dependencies.
//
// Environment: SPLIT_PROJECT (compose project, default crove-split), SPLIT_PORT (default 18080).
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROJECT = process.env.SPLIT_PROJECT ?? 'crove-split';
const BASE_URL = `http://127.0.0.1:${process.env.SPLIT_PORT ?? '18080'}`;
const COMPOSE = ['compose', '-p', PROJECT, '-f', `${ROOT}docker-compose.yml`, '-f', `${ROOT}docker-compose.split.yml`];
// The throwaway values in docker-compose.split.yml.
const INBOUND_SECRET = 'split-stack-inbound-secret-0123456789abcdef';
const BUCKET = 'crove-files';
const INVOICE = readFileSync(`${ROOT}apps/extract/test/fixtures/einvoice-basic.xml`);
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
const TOTAL = /^1980000(?:\.0+)?$/;

const started = Date.now();
const log = (message) => console.log(`[split-stack +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
const compose = (args) => docker([...COMPOSE, ...args]);

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe().catch((error) => ({ error }));
    if (last && !last.error) return last;
    // A state that cannot turn into success (a failed extraction) ends the wait at once.
    if (last?.error?.fatal) throw last.error;
    await sleep(1_000);
  }
  throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}${last?.error ? `: ${last.error.message}` : ''}`);
}

async function ok(path) {
  const response = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  return response?.ok ? response : null;
}

// oRPC RPC protocol, as the web app's RPCLink speaks it: POST /api/rpc/<path> with {"json": input}.
async function rpc(token, path, input, org) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (org) headers['x-crove-org'] = org;
  const response = await fetch(`${BASE_URL}/api/rpc/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`rpc ${path}: HTTP ${response.status} ${JSON.stringify(body?.json ?? body)}`);
  return body.json;
}

function containerOf(service) {
  const id = compose(['ps', '-q', service]).trim();
  assert(id !== '', `service ${service} is running`);
  return JSON.parse(docker(['inspect', id]))[0];
}

function checkTopology() {
  const running = compose(['ps', '--services', '--status', 'running']).split(/\r?\n/).filter(Boolean);
  for (const service of ['api', 'worker', 'minio', 'crove-extract']) assert(running.includes(service), `${service} is running`);
  assert(!running.includes('crove'), 'the all-in-one crove service is not running');
  const volumes = docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]).split(/\r?\n/).filter(Boolean);
  assert(!volumes.some((v) => v.endsWith('_files')), `no files volume in project ${PROJECT} (found ${volumes.join(', ')})`);

  const extractNet = `${PROJECT}_extract`;
  for (const service of ['api', 'worker']) {
    const container = containerOf(service);
    assert(container.Mounts.length === 0, `${service} has no volume or bind mount (found ${JSON.stringify(container.Mounts)})`);
    const nets = Object.keys(container.NetworkSettings.Networks);
    assert(nets.includes(extractNet) === (service === 'worker'), `only the worker is on ${extractNet} (${service}: ${nets.join(', ')})`);
    assert(container.Config.Image === 'crove:split', `${service} runs crove:split`);
    const logs = compose(['logs', '--no-color', service]);
    assert(logs.includes(`[storage] s3 bucket ${BUCKET} at minio:9000`), `${service} logs that it stores blobs in the bucket`);
  }
  assert(containerOf('api').Image === containerOf('worker').Image, 'api and worker run the same image');
  log('topology: api and worker are separate containers of one image, no mounts, only the worker reaches crove-extract');
}

async function signUp() {
  const email = `split-${Date.now()}@example.com`;
  const password = 'split-stack-password-0123';
  const response = await fetch(`${BASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  assert(response.ok && typeof body.access_token === 'string', `sign-up returns a session (HTTP ${response.status})`);
  log(`signed up ${email}`);
  return body.access_token;
}

async function waitForProposal(token, slug, match, what) {
  const file = await waitFor(`${what} to be extracted into a proposal`, 90_000, async () => {
    const files = await rpc(token, 'files/recent', undefined, slug);
    const found = files.find(match);
    if (found?.status === 'failed') throw Object.assign(new Error(`${what} failed: ${found.error}`), { fatal: true });
    if (found?.status !== 'proposed' || !found.proposalId) throw new Error(`${what}: ${found ? found.status : 'not filed yet'}`);
    return found;
  });
  const proposal = await rpc(token, 'inbox/get', { id: file.proposalId }, slug);
  assert(proposal.status === 'pending', `${what}: the proposal is pending`);
  assert(proposal.sellerName === SELLER, `${what}: seller ${proposal.sellerName}`);
  assert(TOTAL.test(proposal.total ?? ''), `${what}: total ${proposal.total}`);
  return { file, proposal };
}

function mime(to, filename, attachment) {
  const base64 = attachment.toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(
    [
      'From: Nha cung cap mau <hoadon@example.com>',
      `To: <${to}>`,
      'Subject: Hoa don 1235',
      `Message-ID: <split-${randomUUID()}@example.com>`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="split-boundary"',
      '',
      '--split-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Invoice attached.',
      '--split-boundary',
      `Content-Type: application/xml; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64,
      '--split-boundary--',
      '',
    ].join('\r\n'),
  );
}

// Every object in the bucket, listed with mc inside the MinIO container (its port is not published).
function bucketObjects() {
  return compose(['exec', '-T', 'minio', 'mc', 'ls', '--recursive', '--json', `local/${BUCKET}`])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({ key: entry.key, size: entry.size }));
}

async function main() {
  log(`stack ${PROJECT} at ${BASE_URL}`);
  await waitFor('the api to be ready (migrations applied, auth grants in place)', 180_000, async () => {
    const response = await ok('/readyz');
    if (!response || (await response.json()).ready !== true) throw new Error('not ready');
    if (!(await ok('/auth/v1/health'))) throw new Error('Supabase Auth not answering');
    return true;
  });
  log('api ready');
  checkTopology();

  const token = await signUp();
  const org = await rpc(token, 'org/create', { name: 'Công ty Split Stack', idempotencyKey: randomUUID() });
  const detail = await rpc(token, 'org/get', undefined, org.slug);
  assert(typeof detail.inboundAddress === 'string' && detail.inboundAddress.endsWith('@inbound.crove.test'), 'the org has an inbound address');
  log(`org ${org.slug} created, inbound address on inbound.crove.test`);

  // Upload through the API; only the worker can read it into a proposal.
  const form = new FormData();
  form.append('file', new Blob([INVOICE], { type: 'application/xml' }), 'einvoice-basic.xml');
  const upload = await fetch(`${BASE_URL}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-crove-org': org.slug },
    body: form,
  });
  const uploaded = await upload.json();
  assert(upload.ok && uploaded.files?.[0]?.fileId, `upload accepted (HTTP ${upload.status})`);
  const uploadedId = uploaded.files[0].fileId;
  await waitForProposal(token, org.slug, (f) => f.id === uploadedId, 'the uploaded e-invoice');
  log('upload: the worker extracted the e-invoice into a pending proposal');

  // Inbound email: a second invoice (another number from the same synthetic seller) as an attachment.
  const second = Buffer.from(INVOICE.toString('utf8').replace('<SHDon>1234</SHDon>', '<SHDon>1235</SHDon>'), 'utf8');
  assert(!second.equals(INVOICE), 'the second invoice differs from the first');
  const message = mime(detail.inboundAddress, 'hoadon-1235.xml', second);
  const post = (secret) =>
    fetch(`${BASE_URL}/api/inbound/email`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'x-crove-recipient': detail.inboundAddress, 'content-type': 'message/rfc822' },
      body: message,
    });
  assert((await post('wrong-secret-wrong-secret-wrong-secret-00')).status === 401, 'a wrong inbound secret is refused');
  const accepted = await post(INBOUND_SECRET);
  assert(accepted.status === 202, `inbound email accepted (HTTP ${accepted.status})`);
  const { file: mailed } = await waitForProposal(token, org.slug, (f) => f.filename === 'hoadon-1235.xml', 'the emailed e-invoice');
  log('inbound: the worker filed the attachment and extracted it into a pending proposal');

  // The blobs are objects in MinIO. The raw message is deleted once filed, so wait for that too.
  const expected = [
    { key: `org/${org.orgId}/${sha256(INVOICE)}`, size: INVOICE.byteLength },
    { key: `org/${org.orgId}/${sha256(second)}`, size: second.byteLength },
  ];
  const objects = await waitFor('the raw inbound message to be deleted from the bucket', 30_000, async () => {
    const all = bucketObjects();
    const inbound = all.filter((o) => o.key.startsWith('inbound/'));
    if (inbound.length > 0) throw new Error(`${inbound.length} inbound object(s) left`);
    return all;
  });
  for (const { key, size } of expected) {
    const object = objects.find((o) => o.key === key);
    assert(object, `${key} is in bucket ${BUCKET}`);
    assert(object.size === size, `${key} has ${size} bytes (found ${object.size})`);
  }
  // Read back through the API, which holds no copy of its own.
  for (const [id, bytes] of [
    [uploadedId, INVOICE],
    [mailed.id, second],
  ]) {
    const response = await fetch(`${BASE_URL}/api/files/${id}`, { headers: { authorization: `Bearer ${token}`, 'x-crove-org': org.slug } });
    assert(response.ok && Buffer.from(await response.arrayBuffer()).equals(bytes), `file ${id} reads back from the bucket with its bytes`);
  }
  log(`MinIO holds both files (${objects.length} object(s) in ${BUCKET}), the raw message is gone, and both read back`);

  // Nothing on a local path: the image's default STORAGE_DIR stays empty in both containers.
  for (const service of ['api', 'worker']) {
    const listing = compose(['exec', '-T', service, 'ls', '-A', '/data/files']).trim();
    assert(listing === '', `${service}: /data/files is empty (found ${listing})`);
  }
  log('no blob on local disk in api or worker');
  log('passed');
}

main().catch((error) => {
  console.error(`[split-stack] FAILED: ${error.message}`);
  process.exit(1);
});
