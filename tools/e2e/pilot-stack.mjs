#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end boot of the pilot layout (issue #2133): docker-compose.yml with tools/deploy/compose.pilot.yml, laid out as
// they are on a deploy host (both files in one directory, the images already built), then the real HTTP API:
//   1. the topology: `api` and `worker` run as two containers of one image, the all-in-one `crove` does not, the API holds no
//      WORKER_DATABASE_URL and no EXTRACT_URL, only the worker is on the extract network, both run only the finance module;
//   2. sign up, create an org, upload the synthetic e-invoice: the API stores it on the `files` volume the two containers
//      share, and the worker reads it into a pending proposal through crove-extract.
// It proves that `extends`, `!reset` and `!override` compose the way the unit test's `docker compose config` says, on the
// compose version of the machine it runs on, and that the layout a pilot deploys actually starts and works.
// No AI endpoint: e-invoice XML is read without AI. Plain Node (26+), no dependencies; needs docker with compose.
//
//   docker tag crove:split crove:local && docker tag crove-extract:split crove-extract:local   (or build them as :local)
//   node tools/e2e/pilot-stack.mjs
// Environment: PILOT_PROJECT (compose project, default crove-pilot-<random>; must contain "pilot" and have no containers or
// volumes yet), PILOT_PORT (default 18090). Inherited COMPOSE_* and CROVE_* variables are not passed on.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
// A fresh name per run, so the run only ever removes what it created. A name given in PILOT_PROJECT must not exist yet.
const PROJECT = process.env.PILOT_PROJECT ?? `crove-pilot-${randomBytes(3).toString('hex')}`;
// The project is torn down with its volumes at the end: its name must be one nobody gives a real stack.
if (!/^[a-z][a-z0-9-]{0,30}$/.test(PROJECT) || !PROJECT.includes('pilot')) throw new Error('PILOT_PROJECT is lower-case letters, digits and -, and contains "pilot"');
const PORT = process.env.PILOT_PORT ?? '18090';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), `${PROJECT}-`)).replaceAll('\\', '/');
const COMPOSE = ['compose', '-p', PROJECT, '--project-directory', DIR, '-f', `${DIR}/docker-compose.yml`, '-f', `${DIR}/compose.pilot.yml`];
const INVOICE = readFileSync(`${ROOT}apps/extract/test/fixtures/einvoice-basic.xml`);
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
const TOTAL = /^1980000(?:\.0+)?$/;
const REQUEST_MS = 15_000;

const started = Date.now();
const log = (message) => console.log(`[pilot-stack +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
// An exported CROVE_MODULES, COMPOSE_PROFILES or COMPOSE_FILE would override the empty .env and change the stack under test.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(COMPOSE_|CROVE_)/.test(name)));
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...inherited, PORT, PUBLIC_URL: `http://localhost:${PORT}` } });
const compose = (args) => docker([...COMPOSE, ...args]);

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

async function ok(path) {
  const response = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  return response?.ok ? response : null;
}

async function rpc(token, path, input, org) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (org) headers['x-crove-org'] = org;
  const response = await fetch(`${BASE_URL}/api/rpc/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input === undefined ? {} : { json: input }),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`rpc ${path}: HTTP ${response.status} ${JSON.stringify(body?.json ?? body)}`);
  return body.json;
}

const containerOf = (service) => {
  const id = compose(['ps', '-q', service]).trim();
  assert(id !== '', `service ${service} is running`);
  return JSON.parse(docker(['inspect', id]))[0];
};
const envOf = (container) => Object.fromEntries(container.Config.Env.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

function checkTopology() {
  const running = compose(['ps', '--services', '--status', 'running']).split(/\r?\n/).filter(Boolean);
  for (const service of ['api', 'worker', 'crove-extract']) assert(running.includes(service), `${service} is running`);
  assert(!running.includes('crove'), 'the all-in-one crove service is not running');
  const api = containerOf('api');
  const worker = containerOf('worker');
  const apiEnv = envOf(api);
  const workerEnv = envOf(worker);
  assert(!('WORKER_DATABASE_URL' in apiEnv), 'the API container has no WORKER_DATABASE_URL');
  assert(!('EXTRACT_URL' in apiEnv), 'the API container has no EXTRACT_URL');
  assert(workerEnv['WORKER_DATABASE_URL']?.includes('crove_worker'), 'the worker container has the worker login');
  assert(workerEnv['EXTRACT_URL'] === 'http://crove-extract:8090', 'the worker reaches crove-extract');
  assert(apiEnv['DATABASE_URL']?.includes('crove_app'), 'the API runs on the app login');
  for (const [name, env] of [['api', apiEnv], ['worker', workerEnv]]) assert(env['CROVE_MODULES'] === 'finance', `${name} runs the finance module only (CROVE_MODULES=${env['CROVE_MODULES']})`);
  const extractNet = `${PROJECT}_extract`;
  assert(!Object.keys(api.NetworkSettings.Networks).includes(extractNet), 'the API is not on the extract network');
  assert(Object.keys(worker.NetworkSettings.Networks).includes(extractNet), 'the worker is on the extract network');
  assert(api.Image === worker.Image, 'api and worker run the same image');
  assert(JSON.stringify(api.Config.Cmd) === '["api"]' && JSON.stringify(worker.Config.Cmd) === '["worker"]', `commands api and worker (${api.Config.Cmd}, ${worker.Config.Cmd})`);
  const volume = (container) => container.Mounts.find((m) => m.Destination === '/data/files')?.Name;
  assert(volume(api) !== undefined && volume(api) === volume(worker), 'api and worker share the files volume');
}

// Set once the project is known to be new: only then does the teardown at the end remove it.
let owned = false;

async function main() {
  copyFileSync(`${ROOT}docker-compose.yml`, `${DIR}/docker-compose.yml`);
  copyFileSync(`${ROOT}tools/deploy/compose.pilot.yml`, `${DIR}/compose.pilot.yml`);
  writeFileSync(`${DIR}/.env`, '');
  log(`starting ${PROJECT} from ${DIR}`);
  // The images are the ones built before (crove:local and crove-extract:local): the layout is started, not built.
  // Never take over, and later remove, a project this run did not create.
  const existing = [compose(['ps', '-aq']), docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`])].join('').trim();
  assert(existing === '', `the compose project ${PROJECT} already has containers or volumes: pick another PILOT_PROJECT`);
  owned = true;
  compose(['up', '-d', '--no-build']);

  await waitFor('the api to be ready (migrations applied, auth grants in place)', 240_000, async () => {
    const response = await ok('/readyz');
    if (!response || (await response.json()).ready !== true) throw new Error('not ready');
    if (!(await ok('/auth/v1/health'))) throw new Error('Supabase Auth not answering');
    return true;
  });
  log('api ready');
  await waitFor('the pilot topology', 90_000, async () => {
    checkTopology();
    return true;
  });
  log('topology: api and worker apart, no worker login or sandbox for the API, finance only, one shared files volume');

  const email = `pilot-${Date.now()}@example.com`;
  const signup = await fetch(`${BASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'pilot-stack-password-0123' }),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const session = await signup.json();
  assert(signup.ok && typeof session.access_token === 'string', `sign-up returns a session (HTTP ${signup.status})`);
  const token = session.access_token;
  const org = await rpc(token, 'org/create', { name: 'Công ty Pilot Stack', idempotencyKey: crypto.randomUUID() });
  const form = new FormData();
  form.append('file', new Blob([INVOICE], { type: 'application/xml' }), 'einvoice-basic.xml');
  const upload = await fetch(`${BASE_URL}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-crove-org': org.slug }, body: form, signal: AbortSignal.timeout(REQUEST_MS) });
  const uploaded = await upload.json();
  assert(upload.ok && uploaded.files?.[0]?.fileId, `upload accepted (HTTP ${upload.status})`);
  const id = uploaded.files[0].fileId;
  const file = await waitFor('the worker to read the upload into a proposal', 90_000, async () => {
    const files = await rpc(token, 'files/recent', undefined, org.slug);
    const found = files.find((f) => f.id === id);
    if (found?.status === 'failed') throw Object.assign(new Error(`the reading failed: ${found.error}`), { fatal: true });
    if (found?.status !== 'proposed' || !found.proposalId) throw new Error(found ? found.status : 'not filed yet');
    return found;
  });
  const proposal = await rpc(token, 'inbox/get', { id: file.proposalId }, org.slug);
  assert(proposal.status === 'pending' && proposal.sellerName === SELLER && TOTAL.test(proposal.total ?? ''), `the proposal reads ${proposal.sellerName} ${proposal.total}`);
  log('upload: the API stored it, the worker read it through crove-extract into a pending proposal');
}

try {
  await main();
  console.log(`pilot-stack: passed in ${Math.round((Date.now() - started) / 1000)} s`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  try {
    console.error(compose(['logs', '--no-color', '--tail', '80']));
  } catch {
    // best effort
  }
  process.exitCode = 1;
} finally {
  if (owned) {
    try {
      compose(['down', '-v', '--remove-orphans']);
    } catch {
      // already gone
    }
  }
  rmSync(DIR, { recursive: true, force: true });
}
