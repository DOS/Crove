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
    expect(c.some((l) => / crove$/.test(l))).toBe(false);
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
