// tools/deploy/deploy.sh (issue #56) against stand-ins for docker and curl (tools/test/deploy-stubs): the order of
// the steps, the readiness gate, rollback on a failed smoke test, the state it records, and what it refuses.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../..');
const script = join(repo, 'tools/deploy/deploy.sh');
// Linux and macOS (CI runs it on Linux). Under Git Bash on Windows the same suite takes about 15 minutes, since every
// case forks a few hundred processes; set CROVE_DEPLOY_TESTS=1 to run it there anyway.
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const runHere = hasBash && (process.platform !== 'win32' || process.env['CROVE_DEPLOY_TESTS'] === '1');

const digest = (c: string) => c.repeat(64);
const image = (c: string) => `ghcr.io/example/crove@sha256:${digest(c)}`;
const extract = (c: string) => `ghcr.io/example/crove-extract@sha256:${digest(c)}`;
const releaseDir = (release: string, c: string) => `${release}-${digest(c).slice(0, 12)}`;
// Forward slashes: the script takes absolute paths without backslashes (Git Bash on Windows accepts C:/...).
const slash = (p: string) => p.replaceAll('\\', '/');

let root: string;
let dir: string;
let log: string;
let compose: string;

function run(args: string[], env: Record<string, string> = {}, input?: string) {
  const stubs = join(root, 'bin');
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    input: input ?? '',
    env: {
      ...process.env,
      PATH: `${stubs}${delimiter}${process.env['PATH'] ?? ''}`,
      CROVE_DEPLOY_DIR: dir,
      CROVE_READY_TIMEOUT: '1',
      CROVE_WORKER_SETTLE: '0',
      STUB_LOG: log,
      STUB_DEPLOY_DIR: dir,
      // The account step of the smoke test stays off unless a case turns it on.
      SMOKE_EMAIL: '',
      SMOKE_PASSWORD: '',
      SMOKE_ORG: '',
      ...env,
    },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const deploy = (release: string, c: string, env: Record<string, string> = {}) =>
  run(['deploy', '--release', release, '--image', image(c), '--extract-image', extract(c), '--compose', compose], env);

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l && !l.startsWith('curl ')) : []);
const state = (name: string) => {
  const f = join(dir, '.deploy', name);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
};
const running = () => readFileSync(join(dir, 'docker-compose.override.yml'), 'utf8');
const indexOf = (lines: string[], text: string) => lines.findIndex((l) => l.includes(text));

describe.skipIf(!runHere)('deploy.sh', { timeout: 300_000 }, () => {
  beforeEach(() => {
    root = slash(mkdtempSync(join(tmpdir(), 'crove-deploy-')));
    dir = `${root}/host`;
    log = `${root}/calls.log`;
    compose = `${root}/docker-compose.yml`;
    mkdirSync(dir);
    mkdirSync(`${root}/bin`);
    for (const stub of ['docker', 'curl']) {
      // LF endings whatever the checkout did (core.autocrlf on Windows): bash refuses a CR in the shebang.
      writeFileSync(`${root}/bin/${stub}`, readFileSync(join(import.meta.dirname, 'deploy-stubs', stub), 'utf8').replaceAll('\r\n', '\n'));
      chmodSync(`${root}/bin/${stub}`, 0o755);
    }
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');
    writeFileSync(compose, 'name: crove\nservices: {}\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('pulls by digest, migrates first, then rolls infrastructure, the app and the prober, and records the release', () => {
    const res = deploy('v1.0.0', 'a', { STUB_SERVICES: 'db migrate auth auth-grants crove-extract mailpit crove prober' });
    expect(res.status, res.out).toBe(0);
    const c = calls();
    const order = [
      `pull ${image('a')}`,
      `pull ${extract('a')}`,
      'compose config --quiet',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 db',
      'compose run --rm --no-TTY --no-deps migrate',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 auth',
      'compose run --rm --no-TTY --no-deps auth-grants',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 crove-extract mailpit',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 crove',
      'compose port crove 8080',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 prober',
    ].map((step) => indexOf(c, step));
    expect(order.every((i) => i >= 0), c.join('\n')).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));

    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
    expect(state('previous')).toBe('');
    expect(running()).toContain(`crove: { image: '${image('a')}', build: !reset null }`);
    expect(running()).toContain(`crove-extract: { image: '${extract('a')}', build: !reset null }`);
    expect(readFileSync(`${dir}/docker-compose.yml`, 'utf8')).toBe('name: crove\nservices: {}\n');
    expect(readFileSync(`${dir}/.deploy/history.log`, 'utf8')).toMatch(/deploy v1\.0\.0-a{12} ok/);
    // The script installs itself for a manual rollback.
    expect(readFileSync(`${dir}/.deploy/deploy.sh`, 'utf8')).toBe(readFileSync(script, 'utf8'));
    expect(res.out).toContain('smoke ok: /login loads the app shell and its script bundle');
    expect(existsSync(`${dir}/.deploy/lock`)).toBe(false);
  });

  // #2118, #2133: the pilot's split API and worker. compose.pilot.yml ships with each release, next to its compose file;
  // the host chooses the layout by listing it in COMPOSE_FILE, and the pins of api and worker follow that choice.
  const SPLIT = 'db migrate auth auth-grants crove-extract mailpit api worker';
  const PILOT_ENV = 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:compose.pilot.yml:docker-compose.override.yml:compose.host.yml\n';
  const NOT_PILOT_ENV = 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:compose.host.yml\n';
  const filesOf = () => readFileSync(`${log}.files`, 'utf8').split('\n').filter(Boolean);
  const pins = (c: string) => [`api: { image: '${image(c)}', build: !reset null }`, `worker: { image: '${image(c)}', build: !reset null }`];

  it('uses the release\'s compose.pilot.yml only when COMPOSE_FILE lists it: after the release file, before the pins, host file last', () => {
    writeFileSync(`${dir}/compose.host.yml`, 'services: {}\n');
    // The release carries the file, but the host has not chosen the layout: not passed, not copied, no pins for api and worker.
    writeFileSync(`${root}/compose.pilot.yml`, '# release a\nservices: {}\n');
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/docker-compose.override.yml ${dir}/compose.host.yml`);
    expect(existsSync(`${dir}/compose.pilot.yml`)).toBe(false);
    expect(existsSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}/compose.pilot.yml`)).toBe(true);
    expect(running()).not.toContain('api: {');

    // Listed: the release's copy becomes the host's, in the order the plain docker compose of COMPOSE_FILE uses.
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    writeFileSync(`${root}/compose.pilot.yml`, '# release b\nservices: {}\n');
    rmSync(`${log}.files`);
    const res = deploy('v1.1.0', 'b', { STUB_SERVICES: SPLIT });
    expect(res.status, res.out).toBe(0);
    expect(filesOf().length).toBeGreaterThan(5);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/compose.pilot.yml ${dir}/docker-compose.override.yml ${dir}/compose.host.yml`);
    expect(readFileSync(`${dir}/compose.pilot.yml`, 'utf8')).toContain('# release b');
    // The pins of the release reach api and worker, for a plain docker compose on the host.
    for (const pin of pins('b')) expect(running()).toContain(pin);
    // The split roles roll worker first, then the API, and the smoke test finds the API's port.
    const c = calls();
    // The all-in-one container of an earlier layout goes first, so it keeps neither the API's port nor the worker's jobs.
    expect(indexOf(c, 'compose rm --stop --force crove')).toBeGreaterThanOrEqual(0);
    expect(indexOf(c, 'compose rm --stop --force crove')).toBeLessThan(indexOf(c, 'compose up --detach --no-build --no-deps worker'));
    expect(indexOf(c, 'compose up --detach --no-build --no-deps worker')).toBeLessThan(indexOf(c, 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 api'));
    expect(c.some((l) => l === 'compose port api 8080')).toBe(true);

    // The next release brings its own copy, so the host's stays in step with its docker-compose.yml.
    writeFileSync(`${root}/compose.pilot.yml`, '# release c\nservices: {}\n');
    expect(deploy('v1.2.0', 'c', { STUB_SERVICES: SPLIT }).status).toBe(0);
    expect(readFileSync(`${dir}/compose.pilot.yml`, 'utf8')).toContain('# release c');
  });

  it('takes the pins of api and worker out when the host goes back to one container, and from a release staged with them (#2133)', () => {
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    writeFileSync(`${root}/compose.pilot.yml`, '# pilot\nservices: {}\n');
    expect(deploy('v1.0.0', 'a', { STUB_SERVICES: SPLIT }).status).toBe(0);
    expect(deploy('v1.1.0', 'b', { STUB_SERVICES: SPLIT }).status).toBe(0);
    for (const pin of pins('b')) expect(running()).toContain(pin);
    // A release staged by an earlier deploy.sh carries the pins in its own override file. It is release b, the one the
    // rollback below goes back to, so the pins really are activated again.
    const staged = `${dir}/releases/${releaseDir('v1.1.0', 'b')}/docker-compose.override.yml`;
    writeFileSync(staged, `${readFileSync(staged, 'utf8')}${pins('b').map((l) => `  ${l}\n`).join('')}`);

    // Back to one container: only COMPOSE_FILE changes. The file stays on the host, unused; no bare api or worker is defined.
    writeFileSync(`${dir}/.env`, NOT_PILOT_ENV);
    rmSync(`${log}.files`);
    expect(deploy('v1.2.0', 'c').status).toBe(0);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/docker-compose.override.yml`);
    expect(running()).not.toContain('api: {');
    expect(running()).not.toContain('worker: {');
    // A rollback to the release with the old pins: stripped on activation, so the active override has none either.
    expect(run(['rollback']).status).toBe(0);
    expect(running()).not.toContain('api: {');
    expect(running()).not.toContain('worker: {');
    expect(running()).toContain(`crove: { image: '${image('b')}', build: !reset null }`);
    // And forward again into the pilot layout: the pins come back with the layout.
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    expect(deploy('v1.3.0', 'd', { STUB_SERVICES: SPLIT }).status).toBe(0);
    for (const pin of pins('d')) expect(running()).toContain(pin);
  });

  // #2120: the database image with WAL archiving is the host's file too; a deploy that dropped it would recreate `db`
  // without pgBackRest while the volume keeps pushing WAL with it.
  it('passes compose.wal.yml after the pins and before compose.host.yml, and refuses a COMPOSE_FILE that names it when it is missing (#2120)', () => {
    const filesOf = () => readFileSync(`${log}.files`, 'utf8').split('\n').filter(Boolean);
    writeFileSync(`${dir}/compose.wal.yml`, 'services: {}\n');
    writeFileSync(`${dir}/compose.host.yml`, 'services: {}\n');
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/docker-compose.override.yml ${dir}/compose.wal.yml ${dir}/compose.host.yml`);
    rmSync(`${dir}/compose.wal.yml`);
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:compose.wal.yml\n');
    const res = deploy('v1.1.0', 'b');
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('lists compose.wal.yml but');
  });

  it('stops before pulling when COMPOSE_FILE lists compose.pilot.yml and neither the release nor the host has the file, rather than roll the all-in-one crove (#2118, #2133)', () => {
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    const res = deploy('v1.0.0', 'a', { STUB_SERVICES: 'db migrate auth auth-grants crove-extract mailpit crove' });
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('lists compose.pilot.yml but this release does not carry it');
    expect(calls().some((l) => l.startsWith('pull '))).toBe(false);
    // Any way a dotenv file may spell the assignment counts, and a name inside a comment does not.
    const layout = 'docker-compose.yml:compose.pilot.yml:docker-compose.override.yml';
    for (const line of [`COMPOSE_FILE = ${layout}`, `export COMPOSE_FILE=${layout}`, `  COMPOSE_FILE="${layout}" # pilot`, `COMPOSE_FILE=${layout}\r`]) {
      writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\n${line}\n`);
      expect(deploy('v1.0.0', 'a').status, line).toBe(2);
    }
    for (const line of ['COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml # not compose.pilot.yml', `# COMPOSE_FILE=${layout}`]) {
      writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\n${line}\n`);
      expect(deploy('v1.0.0', 'a').status, line).toBe(0);
    }
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    rmSync(`${log}.files`, { force: true });
    // A copy the host already has is enough for a release that does not ship one (an older release).
    writeFileSync(`${dir}/compose.pilot.yml`, 'services: {}\n');
    expect(deploy('v1.0.0', 'a', { STUB_SERVICES: SPLIT }).status).toBe(0);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/compose.pilot.yml ${dir}/docker-compose.override.yml`);
  });

  it('says so when it cannot remove the old crove container, and goes on', () => {
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    writeFileSync(`${root}/compose.pilot.yml`, 'services: {}\n');
    const res = deploy('v1.0.0', 'a', { STUB_SERVICES: 'db migrate auth auth-grants crove-extract mailpit api worker', STUB_RM_FAIL: '1' });
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('could not remove the old crove container (the deploy goes on): rm: stub failure');
  });

  // #892: with --build, /version must report the build being deployed, so an old container that still answers fails.
  describe('build check', () => {
    const build = (c: string) => digest(c).slice(0, 12);
    const withBuild = (release: string, c: string, env: Record<string, string> = {}) =>
      run(['deploy', '--release', release, '--image', image(c), '--extract-image', extract(c), '--compose', compose, '--build', build(c)], env);
    const versionCalls = () => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('curl ') && l.endsWith('/version'));

    it('checks /version and records the build of the release', () => {
      const res = withBuild('v1.0.0', 'a');
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain(`smoke ok: /version answers build ${build('a')} with every migration applied`);
      expect(readFileSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}/release.env`, 'utf8')).toContain(`BUILD=${build('a')}\n`);
    });

    it('skips /version without --build (a release from before it)', () => {
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      expect(versionCalls()).toEqual([]);
      expect(readFileSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}/release.env`, 'utf8')).toContain('BUILD=\n');
    });

    it('rolls back when an old container answers instead of the new build', () => {
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      const res = withBuild('v1.1.0', 'b', { STUB_STALE_DIGEST: digest('b') });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`smoke: expected build ${build('b')} with no missing migration; /version answered: {"build":"stale","migrationsMissing":[]}`);
      expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
      expect(running()).toContain(image('a'));
    });

    it('rolls back when a committed migration is missing from the ledger', () => {
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      rmSync(log);
      const res = withBuild('v1.1.0', 'b', { STUB_MIGRATION_MISSING: '1' });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`smoke failed: /version answers build ${build('b')} with every migration applied`);
      // The release rolled back to was deployed without a build id: its smoke test does not ask /version.
      expect(versionCalls()).toHaveLength(1);
    });

    it('checks the build of the release it rolls back to, when that release has one', () => {
      expect(withBuild('v1.0.0', 'a').status).toBe(0);
      const failed = withBuild('v1.1.0', 'b', { STUB_NO_BUNDLE_DIGEST: digest('b') });
      expect(failed.status, failed.out).toBe(1);
      expect(failed.out).toContain(`smoke ok: /version answers build ${build('a')} with every migration applied`);
      expect(withBuild('v1.1.0', 'b').status).toBe(0);
      rmSync(log);
      const back = run(['rollback']);
      expect(back.status, back.out).toBe(0);
      expect(back.out).toContain(`smoke ok: /version answers build ${build('a')} with every migration applied`);
    });

    it('refuses a build id with other characters, or an empty one', () => {
      for (const id of ["a'b", '']) {
        const res = run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--compose', compose, '--build', id]);
        expect(res.status, id).toBe(2);
        expect(res.out).toContain('--build must match');
      }
    });
  });

  it('rolls the worker before the API when they run as separate services', () => {
    const res = deploy('v1.0.0', 'a', { STUB_SERVICES: 'db migrate auth auth-grants crove-extract api worker' });
    expect(res.status, res.out).toBe(0);
    const c = calls();
    const worker = indexOf(c, 'compose up --detach --no-build --no-deps worker');
    const ps = indexOf(c, 'compose ps --status running --services');
    const api = indexOf(c, 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 api');
    expect(worker).toBeGreaterThan(indexOf(c, 'run --rm --no-TTY --no-deps migrate'));
    expect(ps).toBeGreaterThan(worker);
    expect(api).toBeGreaterThan(ps);
    expect(indexOf(c, 'compose port api 8080')).toBeGreaterThan(api);
    expect(c.some((l) => / crove$/.test(l) && !l.startsWith('compose rm '))).toBe(false);
  });

  // #1965 (plan §3.5): toward an older release the API goes first, so the worker that runs is never older than the API
  // that serves (whose /readyz waits on an older worker, #1952); toward a newer one, the worker first.
  describe('separate services, toward an older release (#1965)', () => {
    const env = { STUB_SERVICES: 'db migrate auth crove-extract api worker' };
    const worker = 'compose up --detach --no-build --no-deps worker';
    const api = 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 api';
    const last = (lines: string[], text: string) => lines.findLastIndex((l) => l.includes(text));

    it('rolls the API before the worker on a rollback, and the worker before the API on the second one', () => {
      expect(deploy('v1.0.0', 'a', env).status).toBe(0);
      expect(deploy('v1.1.0', 'b', env).status).toBe(0);
      rmSync(log);
      let res = run(['rollback'], env);
      expect(res.status, res.out).toBe(0);
      let c = calls();
      expect(indexOf(c, api)).toBeGreaterThan(-1);
      expect(indexOf(c, worker)).toBeGreaterThan(indexOf(c, api));
      // The worker is still checked: it stays up before the instance is called ready.
      expect(indexOf(c, 'compose ps --status running --services')).toBeGreaterThan(indexOf(c, worker));
      expect(indexOf(c, 'compose port api 8080')).toBeGreaterThan(indexOf(c, worker));
      expect(res.out).toContain('rolling the API (toward an older build: the API before the worker)');
      // The second rollback returns to the release deployed later: toward it, the worker first again.
      rmSync(log);
      res = run(['rollback'], env);
      expect(res.status, res.out).toBe(0);
      c = calls();
      expect(indexOf(c, worker)).toBeGreaterThan(-1);
      expect(indexOf(c, api)).toBeGreaterThan(indexOf(c, worker));
      expect(res.out).not.toContain('the API before the worker');
    });

    it('recovers a failed deploy API first, toward the release that ran before', () => {
      expect(deploy('v1.0.0', 'a', env).status).toBe(0);
      rmSync(log);
      const res = deploy('v1.1.0', 'b', { ...env, STUB_BAD_DIGEST: digest('b') });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
      const c = calls();
      // The deploy: the worker, then the API. The recovery: the API, then the worker.
      expect(indexOf(c, api)).toBeGreaterThan(indexOf(c, worker));
      expect(last(c, worker)).toBeGreaterThan(last(c, api));
      expect(last(c, api)).toBeGreaterThan(indexOf(c, api));
    });

    it('recovers a failed rollback worker first, toward the newer release it left', () => {
      expect(deploy('v1.0.0', 'a', env).status).toBe(0);
      expect(deploy('v1.1.0', 'b', env).status).toBe(0);
      rmSync(log);
      const res = run(['rollback'], { ...env, STUB_BAD_DIGEST: digest('a') });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`rolled back to ${releaseDir('v1.1.0', 'b')}, which serves again`);
      const c = calls();
      // The rollback: the API, then the worker. The recovery: the worker, then the API.
      expect(indexOf(c, worker)).toBeGreaterThan(indexOf(c, api));
      expect(last(c, worker)).toBeGreaterThan(indexOf(c, worker));
      expect(last(c, api)).toBeGreaterThan(last(c, worker));
    });

    it('recovers forward, worker first, when the older worker does not stay up after the API was rolled back', () => {
      expect(deploy('v1.0.0', 'a', env).status).toBe(0);
      expect(deploy('v1.1.0', 'b', env).status).toBe(0);
      rmSync(log);
      const res = run(['rollback'], { ...env, STUB_WORKER_DOWN_DIGEST: digest('a') });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain('the worker is not running');
      expect(res.out).toContain(`rolled back to ${releaseDir('v1.1.0', 'b')}, which serves again`);
      const c = calls();
      expect(indexOf(c, worker)).toBeGreaterThan(indexOf(c, api));
      expect(last(c, worker)).toBeGreaterThan(indexOf(c, worker));
      expect(last(c, api)).toBeGreaterThan(last(c, worker));
    });

    // The build time the image carries orders the rolls, not when the release was deployed: a deploy of an older tag
    // rolls the API first, and the rollback from it, to the newer build, the worker first (Codex and review, #1965).
    it('orders by the build time the images carry, so a deploy of an older tag rolls the API first', () => {
      const times = { ...env, STUB_BUILD_TIMES: `${digest('a')}=2026-10-01T10:00:00+07:00 ${digest('b')}=2026-10-02T09:00:00+07:00` };
      expect(deploy('v1.1.0', 'b', times).status).toBe(0);
      expect(readFileSync(`${dir}/releases/${releaseDir('v1.1.0', 'b')}/release.env`, 'utf8')).toContain(`BUILD_EPOCH=${Date.parse('2026-10-02T02:00:00Z') / 1000}`);
      rmSync(log);
      let res = deploy('v1.0.0', 'a', times);
      expect(res.status, res.out).toBe(0);
      let c = calls();
      expect(indexOf(c, worker)).toBeGreaterThan(indexOf(c, api));
      rmSync(log);
      res = run(['rollback'], times);
      expect(res.status, res.out).toBe(0);
      c = calls();
      expect(indexOf(c, api)).toBeGreaterThan(indexOf(c, worker));
      // The older tag's release records its build time too.
      expect(readFileSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}/release.env`, 'utf8')).toMatch(/BUILD_EPOCH=\d+/);
    });
  });

  it('does not roll the API when the new worker does not stay up, and rolls back', () => {
    const env = { STUB_SERVICES: 'db migrate auth crove-extract api worker' };
    expect(deploy('v1.0.0', 'a', env).status).toBe(0);
    rmSync(log);
    const res = deploy('v1.1.0', 'b', { ...env, STUB_WORKER_DOWN_DIGEST: digest('b') });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('the worker is not running');
    expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}`);
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
    // The new API was never started: the first `up api` after the failed worker belongs to the rollback.
    const c = calls();
    const firstApi = indexOf(c, '--wait-timeout 600 api');
    expect(firstApi).toBeGreaterThan(indexOf(c, 'compose ps --status running --services'));
    expect(c.filter((l) => l.endsWith(' api')).length).toBe(1);
  });

  it('asks for readiness at least once, however short the timeout, so a ready instance is never taken for a failed one (#1841)', () => {
    // A timeout of 0 forces the boundary that made the case above flaky: the whole second passes before the first
    // question, as when bash's SECONDS ticks right after the deadline is set.
    const env = { CROVE_READY_TIMEOUT: '0', STUB_SERVICES: 'db migrate auth crove-extract api worker' };
    const ready = deploy('v1.0.0', 'a', env);
    expect(ready.status, ready.out).toBe(0);
    expect(ready.out).toContain('ready: every committed migration is applied');
    // The rollback after a worker that does not stay up gets its question too, and serves the previous release again.
    rmSync(log);
    const res = deploy('v1.1.0', 'b', { ...env, STUB_WORKER_DOWN_DIGEST: digest('b') });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}`);
    expect(res.out).not.toContain('rollback to');
  });

  it('keeps the previous release and moves on with a second deploy', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    expect(state('current')).toBe(releaseDir('v1.1.0', 'b'));
    expect(state('previous')).toBe(releaseDir('v1.0.0', 'a'));
    expect(running()).toContain(image('b'));
  });

  it('rolls back to the running release when the new one never gets ready, and exits 1', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    const res = deploy('v1.1.0', 'b', { STUB_BAD_DIGEST: digest('b') });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('not ready after 1s');
    expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
    expect(state('previous')).toBe('');
    expect(running()).toContain(image('a'));
    expect(running()).not.toContain(image('b'));
    expect(readFileSync(`${dir}/.deploy/history.log`, 'utf8')).toContain(`deploy ${releaseDir('v1.1.0', 'b')} failed, rolled back to ${releaseDir('v1.0.0', 'a')}`);
  });

  it('never runs the account step of the smoke test on the host, so a rollback cannot depend on the smoke account', () => {
    const res = deploy('v1.0.0', 'a', { SMOKE_EMAIL: 'smoke@example.com', SMOKE_PASSWORD: 'x', SMOKE_ORG: 'crove-smoke', STUB_SIGNIN_FAIL: '1' });
    expect(res.status, res.out).toBe(0);
    expect(res.out).not.toContain('signs in, uploads');
    expect(readFileSync(log, 'utf8')).not.toContain('/auth/v1/token');
  });

  it('rolls back when the smoke test fails after the instance is ready', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    // Ready, but the new release's sign-in page has no script bundle.
    const res = deploy('v1.1.0', 'b', { STUB_NO_BUNDLE_DIGEST: digest('b') });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('smoke failed: /login loads the app shell and its script bundle');
    expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
    expect(running()).toContain(image('a'));
  });

  it('exits 3 when the rollback fails too', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    const res = deploy('v1.1.0', 'b', { STUB_READYZ_FAIL: '1' });
    expect(res.status, res.out).toBe(3);
    expect(res.out).toContain('the instance needs an operator');
    expect(readFileSync(`${dir}/.deploy/history.log`, 'utf8')).toContain('FAILED');
  });

  it('exits 1 without an earlier release to roll back to', () => {
    const res = deploy('v1.0.0', 'a', { STUB_READYZ_FAIL: '1' });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('no earlier release to roll back to');
    expect(state('current')).toBe('');
  });

  it('leaves the services alone when the migration fails', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    rmSync(log);
    const res = deploy('v1.1.0', 'b', { STUB_MIGRATE_EXIT: '1' });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('migrations failed; the services were not changed');
    const c = calls();
    expect(c.slice(indexOf(c, 'migrate')).some((l) => l.startsWith('compose up'))).toBe(false);
    expect(running()).toContain(image('a'));
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
  });

  it('changes nothing when a pull fails', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    rmSync(log);
    const res = deploy('v1.1.0', 'b', { STUB_PULL_FAIL: '1' });
    expect(res.status, res.out).toBe(1);
    expect(calls().some((l) => l.startsWith('compose up') || l.startsWith('compose run'))).toBe(false);
    expect(running()).toContain(image('a'));
  });

  it('rolls back on request, and a second rollback returns', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    rmSync(log);
    let res = run(['rollback']);
    expect(res.status, res.out).toBe(0);
    expect(calls().some((l) => l.includes('migrate'))).toBe(false);
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
    expect(state('previous')).toBe(releaseDir('v1.1.0', 'b'));
    expect(running()).toContain(image('a'));
    res = run(['rollback']);
    expect(res.status, res.out).toBe(0);
    expect(state('current')).toBe(releaseDir('v1.1.0', 'b'));
    expect(run(['status']).out).toContain(`current:  ${releaseDir('v1.1.0', 'b')}`);
  });

  it('refuses a rollback with no previous release', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    const res = run(['rollback']);
    expect(res.status).toBe(2);
    expect(res.out).toContain('no previous release');
  });

  it('logs in with the password from stdin in a throwaway Docker config', () => {
    const res = run(
      ['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--compose', compose, '--registry', 'ghcr.io', '--registry-user', 'bot', '--registry-password-stdin'],
      {},
      'the-token\n',
    );
    expect(res.status, res.out).toBe(0);
    expect(readFileSync(`${log}.password`, 'utf8')).toBe('the-token');
    const c = calls();
    const login = c.find((l) => l.startsWith('login '));
    expect(login).toMatch(/^login DOCKER_CONFIG=\S+ --username bot --password-stdin ghcr\.io$/);
    const config = /DOCKER_CONFIG=(\S+)/.exec(login ?? '')?.[1] ?? '';
    expect(c.filter((l) => l.startsWith('pull ')).every((l) => l.endsWith(`DOCKER_CONFIG=${config}`))).toBe(true);
    // Removed after the pull, and the token appears in no argument.
    expect(existsSync(config)).toBe(false);
    expect(readFileSync(log, 'utf8')).not.toContain('the-token');
    expect(res.out).not.toContain('the-token');
  });

  it.each([
    ['a release id with shell characters', ['--release', 'v1;rm -rf /', '--image', image('a'), '--extract-image', extract('a')], '--release must match'],
    ['an image without a digest', ['--release', 'v1', '--image', 'ghcr.io/example/crove:v1', '--extract-image', extract('a')], '--image must be pinned by digest'],
    ['an extract image without a digest', ['--release', 'v1', '--image', image('a'), '--extract-image', 'crove-extract:latest'], '--extract-image must be pinned'],
  ])('refuses %s before calling docker', (_name, args, message) => {
    const res = run(['deploy', ...args, '--compose', compose]);
    expect(res.status).toBe(2);
    expect(res.out).toContain(message);
    expect(calls()).toEqual([]);
  });

  it('refuses to run without the env file', () => {
    rmSync(`${dir}/.env`);
    const res = deploy('v1.0.0', 'a');
    expect(res.status).toBe(2);
    expect(res.out).toContain('.env not found');
  });

  it('refuses to run while another deploy holds the lock, and clears a stale lock', () => {
    mkdirSync(`${dir}/.deploy/lock`, { recursive: true });
    // This test's own process is alive.
    writeFileSync(`${dir}/.deploy/lock/pid`, `${process.pid}\n`);
    const live = spawnSync('bash', ['-c', `kill -0 ${process.pid}`]).status === 0;
    if (live) {
      const res = deploy('v1.0.0', 'a');
      expect(res.status).toBe(2);
      expect(res.out).toContain('another deploy');
    }
    writeFileSync(`${dir}/.deploy/lock/pid`, '999999\n');
    const res = deploy('v1.0.0', 'a');
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('removing a stale lock');
  });

  it('treats a fresh lock without a pid as taken (another run is starting)', () => {
    mkdirSync(`${dir}/.deploy/lock`, { recursive: true });
    const res = deploy('v1.0.0', 'a');
    expect(res.status).toBe(2);
    expect(res.out).toContain('another deploy is starting');
    expect(existsSync(`${dir}/.deploy/lock`)).toBe(true);
  });

  it('pulls the previous images again on a rollback, with the password from stdin', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    rmSync(log);
    const res = run(['rollback', '--registry', 'ghcr.io', '--registry-user', 'github-actions[bot]', '--registry-password-stdin'], {}, 'the-token\n');
    expect(res.status, res.out).toBe(0);
    const c = calls();
    expect(c.some((l) => l.startsWith('login ') && l.endsWith('--username github-actions[bot] --password-stdin ghcr.io'))).toBe(true);
    expect(indexOf(c, `pull ${image('a')}`)).toBeGreaterThanOrEqual(0);
    expect(indexOf(c, `pull ${extract('a')}`)).toBeGreaterThanOrEqual(0);
    expect(readFileSync(log, 'utf8')).not.toContain('the-token');
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
  });

  it('keeps the newest releases and never removes the current or previous one', () => {
    for (const [i, c] of ['a', 'b', 'c', 'd'].entries()) expect(deploy(`v1.${i}.0`, c, { CROVE_KEEP_RELEASES: '2' }).status).toBe(0);
    const left = readdirSync(`${dir}/releases`).sort();
    expect(left).toEqual([releaseDir('v1.2.0', 'c'), releaseDir('v1.3.0', 'd')]);
  });

  describe('smoke', () => {
    it('passes when every check answers', () => {
      const res = run(['smoke', 'https://crove.example.test/']);
      expect(res.status, res.out).toBe(0);
      const urls = readFileSync(log, 'utf8');
      for (const path of ['/healthz', '/readyz', '/api/config', '/auth/v1/health', '/login', '/assets/index-abc123.js']) {
        expect(urls).toContain(`curl https://crove.example.test${path}\n`);
      }
    });

    it('checks /version when given the build being deployed (#892)', () => {
      const ok = run(['smoke', 'https://crove.example.test', 'dev']);
      expect(ok.status, ok.out).toBe(0);
      expect(ok.out).toContain('smoke ok: /version answers build dev with every migration applied');
      const other = run(['smoke', 'https://crove.example.test', '0123456789ab']);
      expect(other.status).toBe(1);
      expect(other.out).toContain('smoke failed: /version answers build 0123456789ab with every migration applied');
      const behind = run(['smoke', 'https://crove.example.test', 'dev'], { STUB_MIGRATION_MISSING: '1' });
      expect(behind.status).toBe(1);
      expect(behind.out).toContain('"migrationsMissing":["20990101000000_crove_kernel_next.sql"]');
      expect(run(['smoke', 'https://crove.example.test']).out).not.toContain('/version');
      expect(run(['smoke', 'https://crove.example.test', 'a b']).status).toBe(2);
    });

    it('fails, naming the check, when one does not answer', () => {
      const res = run(['smoke', 'https://crove.example.test'], { STUB_READYZ_FAIL: '1' });
      expect(res.status).toBe(1);
      expect(res.out).toContain('smoke failed: /readyz answers ready');
      expect(res.out).toContain('smoke ok: /healthz answers ok');
    });

    describe('account step (#690)', () => {
      // A password with characters a JSON body or a shell would have to escape.
      const PASSWORD = 'smoke "pass" \\ word $HOME 0123';
      const account = { SMOKE_EMAIL: 'smoke@example.com', SMOKE_PASSWORD: PASSWORD, SMOKE_ORG: 'crove-smoke', CROVE_SMOKE_POLL_SECONDS: '1' };
      const STEP = 'signs in, uploads a synthetic e-invoice to org crove-smoke and gets a proposal';
      const read = (suffix: string) => (existsSync(`${log}.${suffix}`) ? readFileSync(`${log}.${suffix}`, 'utf8') : '');

      it('is skipped with a notice without SMOKE_EMAIL and SMOKE_PASSWORD', () => {
        const res = run(['smoke', 'https://crove.example.test'], { SMOKE_EMAIL: 'smoke@example.com' });
        expect(res.status, res.out).toBe(0);
        expect(res.out).toContain('smoke skipped: sign-in and upload (SMOKE_EMAIL and SMOKE_PASSWORD are not set)');
        expect(readFileSync(log, 'utf8')).not.toContain('/auth/v1/token');
      });

      it('fails the smoke command, which makes the workflow roll back', () => {
        const res = run(['smoke', 'https://crove.example.test'], { ...account, STUB_SIGNIN_FAIL: '1' });
        expect(res.status).toBe(1);
        expect(res.out).toContain('smoke test failed on https://crove.example.test');
      });

      it('signs in, uploads one synthetic e-invoice, waits for its proposal and rejects it', () => {
        const res = run(['smoke', 'https://crove.example.test'], account);
        expect(res.status, res.out).toBe(0);
        expect(res.out).toContain(`smoke ok: ${STEP}`);
        expect(JSON.parse(read('signin'))).toEqual({ email: 'smoke@example.com', password: PASSWORD });
        const invoice = read('upload');
        expect(invoice).toMatch(/<SHDon>\d{10}<\/SHDon>/);
        // Synthetic parties only: tax codes that fail the checksum.
        expect(invoice).toContain('<MST>0101234564</MST>');
        expect(invoice).toContain('<MST>0309876546</MST>');
        expect(JSON.parse(read('rpc'))).toEqual({ json: { id: 'proposal-1', reason: 'Kiểm thử sau triển khai' } });
        // Neither the password nor the access token is on any command line.
        const argv = read('argv');
        expect(argv).toContain('/auth/v1/token?grant_type=password');
        expect(argv).not.toContain('"pass"');
        expect(argv).not.toContain('stub-access-token');
      });

      it('fails when the sign-in is refused, without uploading', () => {
        const res = run(['smoke', 'https://crove.example.test'], { ...account, STUB_SIGNIN_FAIL: '1' });
        expect(res.status).toBe(1);
        expect(res.out).toContain('smoke: signing in with SMOKE_EMAIL and SMOKE_PASSWORD failed');
        expect(res.out).toContain(`smoke failed: ${STEP}`);
        expect(read('upload')).toBe('');
      });

      it('fails when the worker cannot extract the upload, or no proposal comes in time', () => {
        const failed = run(['smoke', 'https://crove.example.test'], { ...account, STUB_FILE_STATUS: 'failed' });
        expect(failed.status).toBe(1);
        expect(failed.out).toContain('smoke: the worker could not extract the synthetic e-invoice: UNREADABLE');
        const pending = run(['smoke', 'https://crove.example.test'], { ...account, STUB_FILE_STATUS: 'extracting' });
        expect(pending.status).toBe(1);
        expect(pending.out).toContain('smoke: no proposal after 1s (file extracting)');
        // An empty proposal id is not filled from the next field.
        const noId = run(['smoke', 'https://crove.example.test'], { ...account, STUB_FILE_STATUS: 'proposed-no-id' });
        expect(noId.status).toBe(1);
        expect(noId.out).toContain('smoke: no proposal after 1s (file proposed)');
        expect(read('rpc')).toBe('');
      });

      it('fails when the proposal cannot be rejected', () => {
        const res = run(['smoke', 'https://crove.example.test'], { ...account, STUB_REJECT_FAIL: '1' });
        expect(res.status).toBe(1);
        expect(res.out).toContain('smoke: rejecting the smoke proposal proposal-1 failed');
      });

      it('never sends the password over plain http to another host', () => {
        const res = run(['smoke', 'http://crove.example.test'], account);
        expect(res.status).toBe(1);
        expect(res.out).toContain('the account step signs in only over https');
        expect(read('signin')).toBe('');
      });

      it('refuses an org that is not a slug', () => {
        const res = run(['smoke', 'https://crove.example.test'], { ...account, SMOKE_ORG: 'Crove Smoke' });
        expect(res.status).toBe(1);
        expect(res.out).toContain("SMOKE_ORG must be the smoke org's slug");
        expect(read('signin')).toBe('');
      });
    });
  });
});
