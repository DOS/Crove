// Pilot readiness preflight (issue #308): the settings checks, the live probe with a fake fetch, and the exit codes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { vaultKeyId, type S3Sender } from '@crove/kernel-runtime';
import { KNOWN_DEFAULTS, PILOT_EXIT, REQUIRED_SECRETS, checkEnv, parsePilotArgs, probeBuildChecks, probeDeployment, objectLockProbe, probeEvidenceHolds, runPilotCheck, type CheckResult, type Env, type Fetch } from '../src/pilot-check.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Stand-in secrets built at run time, so no literal looks like a leaked key to gitleaks.
const fake = (name: string, length = 20) => `${name}-`.padEnd(length, '7');

const READY: Env = {
  PUBLIC_URL: 'https://crove.example.com',
  TRUSTED_PROXY_HOPS: '1',
  POSTGRES_PASSWORD: fake('pg'),
  CROVE_APP_DB_PASSWORD: fake('app'),
  CROVE_WORKER_DB_PASSWORD: fake('worker'),
  CROVE_PROBER_DB_PASSWORD: fake('prober'),
  CROVE_REPORTER_DB_PASSWORD: fake('reporter'),
  AUTH_DB_PASSWORD: fake('auth'),
  AUTH_JWT_SECRET: fake('jwt', 40),
  EXPORT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  AUTH_AUTOCONFIRM: 'false',
  AUTH_STEP_UP: 'required',
  AUTH_DISABLE_SIGNUP: 'true',
  SMTP_HOST: 'smtp.mailprovider.example',
  ALERT_WEBHOOK_URL: `https://alerts.example.com/hook/${fake('hook')}`,
  PROBER_HEARTBEAT_URL: `https://hc.example.com/ping/${fake('check')}`,
  COMPOSE_PROFILES: 'prober',
  COMPOSE_FILE: 'docker-compose.yml:compose.pilot.yml:docker-compose.override.yml:compose.host.yml',
  CROVE_MODULES: 'finance',
  BACKUP_S3_ENDPOINT: 'https://backups.storage.example',
  BACKUP_S3_BUCKET: 'crove-backups',
  BACKUP_S3_ACCESS_KEY_ID: fake('backup-key'),
  BACKUP_S3_SECRET_ACCESS_KEY: fake('backup-secret'),
  BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  BACKUP_HEARTBEAT_URL: `https://hc.example.com/ping/${fake('backup-check')}`,
};

const failures = (results: readonly CheckResult[]) => results.filter((r) => r.status === 'fail');
const failing = (env: Env) => failures(checkEnv(env)).map((r) => `${r.item}: ${r.message}`);

describe('pilot-check settings', () => {
  it('fails TLS when TRUSTED_PROXY_HOPS does not count the reverse proxy (#564)', () => {
    for (const hops of [undefined, '0', ' ', 'one', '6']) {
      expect(failing({ ...READY, TRUSTED_PROXY_HOPS: hops }), String(hops)).toEqual([expect.stringMatching(/^TLS: TRUSTED_PROXY_HOPS is .*one email budget/)]);
    }
    expect(failing({ ...READY, TRUSTED_PROXY_HOPS: '2' })).toEqual([]);
  });

  // #1214: the previous inbound secret of a rotation, checked as the current one, never printed, and a reminder to
  // remove it.
  it('checks a previous inbound secret like the current one and asks to remove it once the rotation is done (#1214)', () => {
    const current = fake('inbound-current', 40);
    const previous = fake('inbound-previous', 40);
    const env = { ...READY, INBOUND_DOMAIN: 'in.example.com', INBOUND_SECRET: current };
    expect(failing({ ...env, INBOUND_SECRET_PREVIOUS: previous })).toEqual([]);
    const reminder = checkEnv({ ...env, INBOUND_SECRET_PREVIOUS: previous }).find((r) => r.item === 'Secrets' && r.status === 'manual');
    expect(reminder?.message).toMatch(/^INBOUND_SECRET_PREVIOUS is set: an inbound secret rotation is under way/);
    expect(checkEnv(env).some((r) => r.item === 'Secrets' && r.status === 'manual')).toBe(false);
    expect(failing({ ...env, INBOUND_SECRET_PREVIOUS: current })).toEqual(['Secrets: INBOUND_SECRET_PREVIOUS is the same as INBOUND_SECRET']);
    expect(failing({ ...READY, INBOUND_SECRET_PREVIOUS: previous })).toEqual(['Secrets: INBOUND_SECRET_PREVIOUS is set without INBOUND_SECRET']);
    expect(failing({ ...env, INBOUND_SECRET_PREVIOUS: 'short' })).toEqual(['Secrets: INBOUND_SECRET_PREVIOUS is shorter than 32 characters']);
    expect(failing({ ...env, INBOUND_SECRET_PREVIOUS: 'change-me-to-a-long-random-string-0123456789' })).toEqual([
      'Secrets: INBOUND_SECRET_PREVIOUS still has a sample value from .env.example or docker-compose.yml',
    ]);
    for (const result of checkEnv({ ...env, INBOUND_SECRET_PREVIOUS: previous })) expect(result.message).not.toContain(previous);
  });

  // #1888: the worker reports envelopes under a key it cannot open; the preflight names the keys it opens and points there.
  it('names the credential keys the worker opens and fails one that does not parse (#1888)', () => {
    const bytes = (start: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => (start + i * 7) % 256));
    const [current, previous] = [bytes(1), bytes(2)];
    const line = (env: Env) => checkEnv(env).find((r) => r.item === 'Credential key');
    expect(line(READY)).toMatchObject({ status: 'manual', message: expect.stringMatching(/^the worker opens tokens sealed under the key in CREDENTIAL_KEY_FILE .*"\[credential-reseal\] ERROR sealed under a key this worker cannot open"/) });
    expect(line({ ...READY, CREDENTIAL_KEY: current.toString('base64') })?.message).toContain(`the worker opens tokens sealed under CREDENTIAL_KEY (${vaultKeyId(current)}); `);
    expect(line({ ...READY, CREDENTIAL_KEY: current.toString('base64'), CREDENTIAL_KEY_PREVIOUS: previous.toString('hex') })?.message).toContain(
      `the worker opens tokens sealed under CREDENTIAL_KEY (${vaultKeyId(current)}) and CREDENTIAL_KEY_PREVIOUS (${vaultKeyId(previous)}); `,
    );
    // With the key in its file, the previous key from the environment is opened too, and named.
    expect(line({ ...READY, CREDENTIAL_KEY_PREVIOUS: previous.toString('hex') })?.message).toContain(
      `the worker opens tokens sealed under the key in CREDENTIAL_KEY_FILE (docker compose: /data/keys/credential.key on the keys volume) and CREDENTIAL_KEY_PREVIOUS (${vaultKeyId(previous)}); `,
    );
    expect(line(READY)?.message).toContain('docker compose logs worker | grep "cannot open"');
    // A sample value fails as for every optional secret (Codex review): the worker would refuse it at start.
    expect(failing({ ...READY, CREDENTIAL_KEY_PREVIOUS: 'change-me' })).toEqual(['Secrets: CREDENTIAL_KEY_PREVIOUS still has a sample value']);
    expect(failing({ ...READY, CREDENTIAL_KEY: 'not-a-key', CREDENTIAL_KEY_PREVIOUS: previous.toString('hex').slice(2) })).toEqual([
      'Secrets: CREDENTIAL_KEY is not a 32-byte key as base64 or 64 hex characters (openssl rand -base64 32)',
      'Secrets: CREDENTIAL_KEY_PREVIOUS is not a 32-byte key as base64 or 64 hex characters (openssl rand -base64 32)',
    ]);
  });

  it('passes a ready deployment and leaves the human items as manual', () => {
    const results = checkEnv(READY);
    expect(failures(results)).toEqual([]);
    expect(results.filter((r) => r.status === 'manual').map((r) => r.item)).toEqual(['Alerts', 'Credential key', 'Roles', 'Extraction sandbox', 'RLS matrix', 'Backups', 'Evidence holds', 'Owner sign-off']);
    // Evidence holds (#1009): the bucket's Object Lock is confirmed by hand; without S3 or with holds off, the owner
    // accepts that posted files are not held.
    const holds = (env: Record<string, string | undefined>) => checkEnv(env).find((r) => r.item === 'Evidence holds')?.message;
    expect(holds(READY)).toMatch(/^posted invoice files get no retention hold/);
    expect(holds({ ...READY, STORAGE: 's3' })).toMatch(/^confirm the files bucket has Object Lock/);
    expect(holds({ ...READY, STORAGE: 's3', EVIDENCE_LOCK_DAYS: '0' })).toMatch(/^posted invoice files get no retention hold/);
    expect(results.find((r) => r.item === 'Alerts' && r.status === 'pass')?.message).toBe('alerts go to alerts.example.com, from the prober the compose profile starts');
  });

  it('requires alerts on an https webhook the prober accepts (M1-9, issue #309)', () => {
    expect(failing({ ...READY, ALERT_WEBHOOK_URL: undefined })).toEqual([expect.stringContaining('ALERT_WEBHOOK_URL is unset')]);
    expect(failing({ ...READY, ALERT_WEBHOOK_URL: 'http://alerts.example.com/hook' })).toEqual([expect.stringContaining('ALERT_WEBHOOK_URL is not https')]);
    expect(failing({ ...READY, ALERT_WEBHOOK_URL: 'not a url' })).toEqual([expect.stringContaining('ALERT_WEBHOOK_URL is not a URL')]);
    expect(failing({ ...READY, PROBER_HEARTBEAT_URL: 'http://hc.example.com/ping/x' })).toEqual([expect.stringContaining('PROBER_HEARTBEAT_URL is not https')]);
    // The prober's own rules: a Telegram webhook needs the chat id.
    const telegram = { ...READY, ALERT_WEBHOOK_URL: `https://api.telegram.org/bot${fake('token')}/sendMessage` };
    expect(failing(telegram)).toEqual([expect.stringContaining('ALERT_TELEGRAM_CHAT_ID')]);
    expect(failing({ ...telegram, ALERT_TELEGRAM_CHAT_ID: '-1001234567890' })).toEqual([]);
    // A malformed archive setting disables only the prober's marker check (#2094): the preflight says so, naming the setting.
    expect(failing({ ...READY, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'crove-archive', S3_ENDPOINT: 'not a url' })).toEqual([
      'Alerts: the prober would not check the WORM verification marker: invalid archive settings: S3_ENDPOINT (docs/runbooks/worm-archive.md)',
    ]);
    // A bucket that is missing and a half pair of the prober's own key are reported as well.
    expect(failing({ ...READY, ARCHIVE_STORE: 's3' })).toEqual([
      'Alerts: the prober would not check the WORM verification marker: ARCHIVE_STORE=s3 needs ARCHIVE_S3_BUCKET (docs/runbooks/worm-archive.md)',
    ]);
    expect(failing({ ...READY, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'crove-archive', PROBER_ARCHIVE_S3_ACCESS_KEY_ID: fake('reader') })).toEqual([
      expect.stringContaining('set both PROBER_ARCHIVE_S3_ACCESS_KEY_ID and PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY, or neither'),
    ]);
    // No key of its own and no opt-in to the default credential chain (#2098): reported, naming both ways out.
    expect(failing({ ...READY, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'crove-archive' })).toEqual([
      expect.stringContaining('PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true'),
    ]);
    expect(failing({ ...READY, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'crove-archive', PROBER_ARCHIVE_S3_DEFAULT_CHAIN: 'true' })).toEqual([]);
    // The worker's own key in the shared .env is never the prober's: Compose does not pass it, so with it in the .env and no
    // key of the prober's own the preflight still reports that the prober has no credentials, and does not name the key.
    const worker = { S3_ACCESS_KEY_ID: fake('worker-key'), S3_SECRET_ACCESS_KEY: fake('worker-secret') };
    const withWorkerKey = failing({ ...READY, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'crove-archive', ...worker });
    expect(withWorkerKey).toEqual([expect.stringContaining('PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true')]);
    expect(JSON.stringify(withWorkerKey)).not.toContain(worker.S3_ACCESS_KEY_ID);
    expect(failing({ ...READY, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'crove-archive', ...worker, PROBER_ARCHIVE_S3_DEFAULT_CHAIN: 'true' })).toEqual([]);
    // A prober key that is the worker's key is the same mistake whatever Compose passes: reported.
    expect(
      failing({ ...READY, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'crove-archive', ...worker, PROBER_ARCHIVE_S3_ACCESS_KEY_ID: worker.S3_ACCESS_KEY_ID, PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY: fake('reader-secret') }),
    ).toEqual([expect.stringContaining("PROBER_ARCHIVE_S3_ACCESS_KEY_ID is the worker's S3_ACCESS_KEY_ID")]);
    expect(failing({ ...READY, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'crove-archive', ...worker, PROBER_ARCHIVE_S3_ACCESS_KEY_ID: fake('reader'), PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY: fake('reader-secret') })).toEqual([]);
  });

  it("asks a person to confirm the prober's role when it shares the worker's default credential chain (#2109)", () => {
    const manual = (env: Env) => checkEnv(env).filter((r) => r.item === 'Alerts' && r.status === 'manual').map((r) => r.message);
    const shared = { ...READY, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'crove-archive', S3_ACCESS_KEY_ID: undefined, PROBER_ARCHIVE_S3_DEFAULT_CHAIN: 'true' };
    // A warning, not a failure: the deployment may give the prober a role of its own on a host of its own.
    expect(failing(shared)).toEqual([]);
    expect(manual(shared)).toEqual([
      expect.stringContaining('PUBLIC_URL/healthz every 5 minutes'),
      expect.stringContaining("ARCHIVE_STORE=s3 with no S3_ACCESS_KEY_ID (the worker reads and writes the archive on the SDK's default credential chain) and PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true"),
    ]);
    // An empty S3_ACCESS_KEY_ID is the same as none, as the compose file passes it.
    expect(manual({ ...shared, S3_ACCESS_KEY_ID: '' })).toHaveLength(2);
    // Not when the worker has a static key (the prober's chain is then not the worker's), no opt-in, or another store.
    expect(manual({ ...shared, S3_ACCESS_KEY_ID: fake('worker-key') })).toHaveLength(1);
    expect(manual({ ...shared, PROBER_ARCHIVE_S3_DEFAULT_CHAIN: undefined })).toHaveLength(1);
    expect(manual({ ...shared, PROBER_ARCHIVE_S3_DEFAULT_CHAIN: 'false' })).toHaveLength(1);
    expect(manual({ ...shared, ARCHIVE_STORE: 'local' })).toHaveLength(1);
    // Not beside the failures it would only repeat: a pair of its own with the opt-in (refused), no bucket, a bad endpoint.
    const reader = { PROBER_ARCHIVE_S3_ACCESS_KEY_ID: fake('reader'), PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY: fake('reader-secret') };
    expect(manual({ ...shared, ...reader })).toHaveLength(1);
    expect(manual({ ...shared, ARCHIVE_S3_BUCKET: undefined })).toHaveLength(1);
    expect(manual({ ...shared, S3_ENDPOINT: 'not a url' })).toHaveLength(1);
  });

  it('requires backups in a second location over https, apart from the files bucket (issues #307, #351)', () => {
    expect(checkEnv(READY).find((r) => r.item === 'Backups' && r.status === 'pass')?.message).toBe(
      'backups go to backups.storage.example, bucket crove-backups, sealed with BACKUP_ENCRYPTION_KEY',
    );
    expect(failing({ ...READY, BACKUP_S3_ENDPOINT: undefined })).toEqual([expect.stringContaining("BACKUP_S3_ENDPOINT is unset: the nightly backups stay on the server's own disk")]);
    expect(failing({ ...READY, BACKUP_S3_ENDPOINT: 'http://backups.storage.example' })).toEqual([expect.stringContaining('travel in the clear')]);
    expect(failing({ ...READY, BACKUP_S3_ENDPOINT: 'https://127.0.0.1:9000' })).toEqual([expect.stringContaining('not a second location')]);
    expect(failing({ ...READY, BACKUP_S3_SECRET_ACCESS_KEY: undefined })).toEqual([expect.stringContaining('BACKUP_S3_SECRET_ACCESS_KEY is unset')]);
    const sameBucket = { ...READY, STORAGE: 's3', S3_ENDPOINT: 'https://backups.storage.example', S3_BUCKET: 'crove-backups' };
    expect(failing(sameBucket)).toEqual([expect.stringContaining('BACKUP_S3_BUCKET is the files bucket itself')]);
    expect(failing({ ...READY, BACKUP_ENCRYPTION_KEY: 'change-me' })).toEqual([expect.stringContaining('BACKUP_ENCRYPTION_KEY is not 32 bytes')]);
    expect(failing({ ...READY, BACKUP_ENCRYPTION_KEY: READY.EXPORT_ENCRYPTION_KEY })).toEqual([expect.stringContaining('give each its own key')]);
    // The same 32 bytes written as hex are the same key.
    expect(failing({ ...READY, BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('hex') })).toEqual([expect.stringContaining('give each its own key')]);
    expect(failing({ ...READY, BACKUP_HEARTBEAT_URL: 'http://hc.example.com/ping/x' })).toEqual([expect.stringContaining('BACKUP_HEARTBEAT_URL is not https')]);
    // Without a heartbeat it passes, and asks the owner to accept or fix it. Without a key it fails (#2118, below).
    const manual = checkEnv({ ...READY, BACKUP_HEARTBEAT_URL: undefined }).filter((r) => r.item === 'Backups' && r.status !== 'pass');
    expect(manual.map((r) => r.status)).toEqual(['manual', 'manual']);
    expect(manual.map((r) => r.message)).toEqual([
      expect.stringContaining('BACKUP_HEARTBEAT_URL is unset'),
      expect.stringContaining('restore onto a scratch stack passed'),
    ]);
  });

  it('asks to confirm the prober cron and the heartbeat when the settings do not show them', () => {
    const manual = (env: Env) => checkEnv(env).filter((r) => r.item === 'Alerts' && r.status === 'manual').map((r) => r.message);
    expect(manual(READY)).toEqual([expect.stringContaining('PUBLIC_URL/healthz every 5 minutes')]);
    const bare = manual({ ...READY, COMPOSE_PROFILES: undefined, PROBER_HEARTBEAT_URL: undefined });
    expect(bare).toEqual([expect.stringContaining('healthz'), expect.stringContaining('COMPOSE_PROFILES does not include prober'), expect.stringContaining('PROBER_HEARTBEAT_URL is unset')]);
    expect(manual({ ...READY, COMPOSE_PROFILES: 'tools, prober' })).toHaveLength(1);
  });

  it('fails an empty .env: docker compose would run every local default', () => {
    const problems = failing({});
    expect(problems.some((p) => p.startsWith('TLS: PUBLIC_URL is unset'))).toBe(true);
    for (const name of REQUIRED_SECRETS) expect(problems.some((p) => p.startsWith(`Secrets: ${name} is unset`)), name).toBe(true);
    expect(problems.some((p) => p.includes('AUTH_AUTOCONFIRM is unset'))).toBe(true);
    expect(problems.some((p) => p.includes('SMTP_HOST is unset'))).toBe(true);
    expect(problems.some((p) => p.startsWith('Sign-up limited: AUTH_DISABLE_SIGNUP is unset'))).toBe(true);
  });

  // #2118: the settings that make a deployment other people reach safe by default.
  describe('pilot defaults (#2118)', () => {
    const stripped = (message: string) => message.replace(/^[^:]+: /, '');

    it('fails when the API and the worker run as the one all-in-one process', () => {
      for (const env of [{ COMPOSE_FILE: undefined }, { COMPOSE_FILE: 'docker-compose.yml:compose.host.yml' }, { COMPOSE_FILE: 'docker-compose.yml:docker-compose.split.yml' }]) {
        expect(failing({ ...READY, ...env }), JSON.stringify(env)).toEqual([expect.stringMatching(/^Roles: COMPOSE_FILE (?:does not list compose\.pilot\.yml|and CROVE_ROLES are unset).*command all/)]);
      }
      expect(failing({ ...READY, COMPOSE_PROFILES: 'prober,all-in-one' })).toEqual([expect.stringMatching(/^Roles: COMPOSE_PROFILES includes all-in-one/)]);
      expect(failing({ ...READY, COMPOSE_PROFILES: 'all-in-one' })).toEqual([expect.stringMatching(/^Roles: COMPOSE_PROFILES includes all-in-one/)]);
      // `*` starts every profile.
      for (const profiles of ['*', 'prober,*']) expect(failing({ ...READY, COMPOSE_PROFILES: profiles }), profiles).toEqual([expect.stringMatching(/^Roles: COMPOSE_PROFILES includes all-in-one \(or \*\)/)]);
    });

    it('accepts the pilot compose file in any position, as a path, with either list separator', () => {
      for (const file of ['compose.pilot.yml', '/opt/crove/docker-compose.yml:/opt/crove/compose.pilot.yml', 'docker-compose.yml;compose.pilot.yml;compose.host.yml', String.raw`C:\crove\docker-compose.yml;C:\crove\compose.pilot.yml`]) {
        expect(failing({ ...READY, COMPOSE_FILE: file }), file).toEqual([]);
      }
      // A file that only ends the same way is another file.
      expect(failing({ ...READY, COMPOSE_FILE: 'docker-compose.yml:my-compose.pilot.yml' })).toEqual([expect.stringContaining('Roles: COMPOSE_FILE does not list')]);
    });

    it('takes the roles a deployment without docker compose names in CROVE_ROLES', () => {
      expect(failing({ ...READY, COMPOSE_FILE: undefined, CROVE_ROLES: 'api, worker' })).toEqual([]);
      expect(failing({ ...READY, COMPOSE_FILE: undefined, CROVE_ROLES: 'worker,api' })).toEqual([]);
      expect(failing({ ...READY, COMPOSE_FILE: undefined, CROVE_ROLES: 'all' })).toEqual([expect.stringContaining('Roles: CROVE_ROLES includes all')]);
      expect(failing({ ...READY, COMPOSE_FILE: undefined, CROVE_ROLES: 'api' })).toEqual([expect.stringContaining('Roles: CROVE_ROLES must name both api and worker')]);
      expect(failing({ ...READY, COMPOSE_FILE: undefined, CROVE_ROLES: 'api,worker,all' })).toEqual([expect.stringContaining('CROVE_ROLES includes all')]);
      // A COMPOSE_FILE without the pilot file wins over the statement: docker compose would run all-in-one.
      expect(failing({ ...READY, COMPOSE_FILE: 'docker-compose.yml', CROVE_ROLES: 'api,worker' })).toEqual([expect.stringMatching(/^Roles: COMPOSE_FILE does not list compose\.pilot\.yml/)]);
    });

    it('fails an empty or unknown CROVE_MODULES', () => {
      for (const modules of [undefined, '', '  ', ' , ']) {
        expect(failing({ ...READY, CROVE_MODULES: modules }), String(modules)).toEqual([expect.stringMatching(/^Modules: CROVE_MODULES is empty: .*Social's public routes/)]);
      }
      // The prober refuses the same list on its own (Alerts), so look at the item.
      expect(failing({ ...READY, CROVE_MODULES: 'finance,sosial' })).toContainEqual(expect.stringContaining('Modules: CROVE_MODULES names 1 module(s) this build does not ship'));
      expect(failing({ ...READY, CROVE_MODULES: 'Finance, CRM' })).toEqual([]);
    });

    it('fails backups with no BACKUP_ENCRYPTION_KEY and drops the manual line it replaces', () => {
      const env = { ...READY, BACKUP_ENCRYPTION_KEY: undefined };
      expect(failing(env)).toEqual([expect.stringMatching(/^Backups: BACKUP_ENCRYPTION_KEY is unset: whoever can read the backup bucket/)]);
      expect(checkEnv(env).filter((r) => r.status === 'manual' && r.message.startsWith('BACKUP_ENCRYPTION_KEY is unset'))).toEqual([]);
      expect(failing({ ...env, BACKUP_ENCRYPTION_KEY: ' ' })).toHaveLength(1);
    });

    it('fails an AI key with every AI_PRICE_* at 0, so the cost cap does nothing', () => {
      const ai = { ...READY, AI_API_KEY: fake('ai') };
      const expected = [expect.stringMatching(/^AI cost cap: AI_API_KEY is set while AI_PRICE_INPUT_PER_MTOK and AI_PRICE_OUTPUT_PER_MTOK are both 0/)];
      expect(failing(ai)).toEqual(expected);
      expect(failing({ ...ai, AI_PRICE_INPUT_PER_MTOK: '0', AI_PRICE_OUTPUT_PER_MTOK: '0.0' })).toEqual(expected);
      expect(failing({ ...ai, AI_PRICE_INPUT_PER_MTOK: '3' })).toEqual([]);
      expect(failing({ ...ai, AI_PRICE_OUTPUT_PER_MTOK: '15.5' })).toEqual([]);
      // No key, no AI calls, nothing to cap.
      expect(failing({ ...READY, AI_API_KEY: undefined })).toEqual([]);
      expect(failing({ ...READY, AI_API_KEY: '' })).toEqual([]);
    });

    it('names the setting, never its value', () => {
      const secret = fake('never-print-this', 40);
      const env = { ...READY, COMPOSE_FILE: secret, CROVE_MODULES: secret, AI_API_KEY: secret, CROVE_ROLES: secret, BACKUP_ENCRYPTION_KEY: undefined };
      const messages = failures(checkEnv(env)).map((r) => stripped(r.message));
      expect(messages.length).toBeGreaterThanOrEqual(4);
      for (const message of messages) expect(message).not.toContain(secret);
    });

    it('checks none of this on a loopback or unset PUBLIC_URL, where TLS already fails', () => {
      const local = { ...READY, PUBLIC_URL: 'http://localhost:8080', COMPOSE_FILE: undefined, CROVE_MODULES: undefined, AI_API_KEY: fake('ai'), BACKUP_ENCRYPTION_KEY: undefined };
      const items = failures(checkEnv(local)).map((r) => r.item);
      expect(items).toEqual(['TLS']);
      expect(checkEnv(local).some((r) => r.item === 'Roles' || r.item === 'Modules' || r.item === 'AI cost cap')).toBe(false);
    });

    it('asks a person to confirm the running roles', () => {
      expect(checkEnv(READY).find((r) => r.item === 'Roles' && r.status === 'manual')?.message).toMatch(/docker compose ps lists api and worker and no crove service/);
    });
  });

  it('requires https on the public URLs browsers open', () => {
    expect(failing({ ...READY, PUBLIC_URL: 'http://crove.example.com' })).toEqual([expect.stringContaining('PUBLIC_URL is http://crove.example.com')]);
    expect(failing({ ...READY, PUBLIC_URL: 'https://localhost:8080' })).toEqual([expect.stringContaining('loopback')]);
    expect(failing({ ...READY, PUBLIC_URL: 'not a url' })).toEqual([expect.stringContaining('not a URL')]);
    expect(failing({ ...READY, PUBLIC_AUTH_URL: 'http://auth.example.com/auth/v1' })).toEqual([expect.stringContaining('PUBLIC_AUTH_URL')]);
    const s3 = { ...READY, STORAGE: 's3', S3_ENDPOINT: 'http://minio:9000' };
    expect(failing(s3)).toEqual([expect.stringContaining('S3_ENDPOINT')]);
    expect(failing({ ...s3, S3_PUBLIC_ENDPOINT: 'https://files.example.com' })).toEqual([]);
    expect(failing({ ...s3, S3_PUBLIC_ENDPOINT: 'http://files.example.com' })).toEqual([expect.stringContaining('S3_PUBLIC_ENDPOINT')]);
    // Transfers through the kernel never send the browser to the bucket.
    expect(failing({ ...s3, S3_PRESIGNED_URLS: 'false' })).toEqual([]);
  });

  it('refuses sample, short and malformed secrets', () => {
    expect(failing({ ...READY, POSTGRES_PASSWORD: 'change-me-postgres' })).toEqual([expect.stringContaining('POSTGRES_PASSWORD still has a sample value')]);
    expect(failing({ ...READY, AUTH_DB_PASSWORD: 'my-own-Change-Me-pass' })).toEqual([expect.stringContaining('AUTH_DB_PASSWORD still has a sample value')]);
    expect(failing({ ...READY, CROVE_APP_DB_PASSWORD: 'short' })).toEqual([expect.stringContaining('shorter than 16')]);
    expect(failing({ ...READY, AUTH_JWT_SECRET: 'x'.repeat(31) })).toEqual([expect.stringContaining('shorter than 32')]);
    expect(failing({ ...READY, EXPORT_ENCRYPTION_KEY: 'not-a-key' })).toEqual([expect.stringContaining('EXPORT_ENCRYPTION_KEY is not 32 bytes')]);
    expect(failing({ ...READY, INBOUND_DOMAIN: 'in.example.com' })).toEqual([expect.stringContaining('INBOUND_SECRET is unset')]);
    expect(failing({ ...READY, INBOUND_DOMAIN: 'in.example.com', INBOUND_SECRET: 'z'.repeat(40) })).toEqual([]);
    expect(failing({ ...READY, S3_SECRET_ACCESS_KEY: 'crove-split-minio-secret' })).toEqual([expect.stringContaining('S3_SECRET_ACCESS_KEY still has a sample value')]);
  });

  it('requires email confirmation with a real SMTP server and MFA step-up', () => {
    expect(failing({ ...READY, AUTH_AUTOCONFIRM: 'true' })).toEqual([expect.stringContaining('AUTH_AUTOCONFIRM=true')]);
    expect(failing({ ...READY, AUTH_AUTOCONFIRM: undefined })).toEqual([expect.stringContaining('AUTH_AUTOCONFIRM is unset')]);
    expect(failing({ ...READY, SMTP_HOST: 'smtp.example.com' })).toEqual([expect.stringContaining('SMTP_HOST is smtp.example.com')]);
    expect(failing({ ...READY, SMTP_HOST: 'mailpit' })).toEqual([expect.stringContaining('SMTP_HOST is mailpit')]);
    expect(failing({ ...READY, SMTP_HOST: '127.0.0.1' })).toEqual([expect.stringContaining('SMTP_HOST is 127.0.0.1')]);
    expect(failing({ ...READY, AUTH_STEP_UP: 'off' })).toEqual([expect.stringContaining('AUTH_STEP_UP=off')]);
    // Unset is the kernel's and docker compose's default, required.
    expect(failing({ ...READY, AUTH_STEP_UP: undefined })).toEqual([]);
  });

  it('requires sign-up to be closed', () => {
    expect(failing({ ...READY, AUTH_DISABLE_SIGNUP: 'false' })).toEqual([expect.stringContaining('AUTH_DISABLE_SIGNUP is false')]);
    expect(failing({ ...READY, AUTH_DISABLE_SIGNUP: undefined })).toEqual([expect.stringContaining('AUTH_DISABLE_SIGNUP is unset')]);
  });

  it('accepts sign-up limited by the invite-only or allowlist policy instead (#350)', () => {
    expect(failing({ ...READY, AUTH_DISABLE_SIGNUP: 'false', AUTH_SIGNUP_POLICY: 'invite_only' })).toEqual([]);
    expect(failing({ ...READY, AUTH_DISABLE_SIGNUP: 'false', AUTH_SIGNUP_POLICY: 'allowlist', AUTH_SIGNUP_ALLOWED_DOMAINS: 'partner.vn' })).toEqual([]);
    expect(failing({ ...READY, AUTH_DISABLE_SIGNUP: 'false', AUTH_SIGNUP_POLICY: 'allowlist' })).toEqual([expect.stringContaining('without AUTH_SIGNUP_ALLOWED_DOMAINS')]);
    expect(failing({ ...READY, AUTH_DISABLE_SIGNUP: 'false', AUTH_SIGNUP_POLICY: 'open' })).toEqual([expect.stringContaining('AUTH_SIGNUP_POLICY is open')]);
  });

  it('knows every secret value this repository ships in .env.example and the compose files', () => {
    const secrets = new Set<string>([...REQUIRED_SECRETS, 'INBOUND_SECRET', 'S3_SECRET_ACCESS_KEY']);
    const shipped: string[] = [];
    for (const line of readFileSync(`${ROOT}.env.example`, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
      if (match && secrets.has(match[1]!)) shipped.push(match[2]!);
    }
    for (const file of ['docker-compose.yml', 'docker-compose.split.yml']) {
      const text = readFileSync(`${ROOT}${file}`, 'utf8');
      for (const match of text.matchAll(/\$\{([A-Z0-9_]+):-([^}]+)\}/g)) if (secrets.has(match[1]!)) shipped.push(match[2]!);
      for (const match of text.matchAll(/^\s+([A-Z0-9_]+): ([^${\s][^\s]*)$/gm)) if (secrets.has(match[1]!)) shipped.push(match[2]!.replace(/^'|'$/g, ''));
    }
    expect(shipped.length).toBeGreaterThan(10);
    for (const value of shipped) expect(KNOWN_DEFAULTS.has(value), value).toBe(true);
  });
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>): Fetch {
  return async (input, init) => {
    const route = routes[input];
    if (!route) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    return route(input, init);
  };
}

const json = (body: unknown, status = 200) => () => Response.json(body, { status });
// What the sign-up probe meets: Crove's policy refusal, Supabase Auth with sign-up closed, or Supabase Auth refusing
// the password-less body (sign-up open).
const SIGNUP = 'https://crove.example.com/auth/v1/signup';
const refusedByPolicy = json({ code: 403, error_code: 'signup_not_allowed', msg: 'Email này chưa được phép đăng ký tài khoản' }, 403);
const signupDisabled = json({ code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' }, 422);
const reachedAuth = json({ code: 400, error_code: 'validation_failed', msg: 'Signup requires a valid password' }, 400);
const healthy = {
  'https://crove.example.com/healthz': json({ ok: true }),
  'https://crove.example.com/api/config': json({ authUrl: 'https://crove.example.com/auth/v1', authAnonKey: null }),
  'https://crove.example.com/auth/v1/settings': json({ disable_signup: true, mailer_autoconfirm: false }),
  [SIGNUP]: signupDisabled,
};

describe('pilot-check probe', () => {
  it('passes a deployment with valid TLS, closed plain http and closed sign-up', async () => {
    const results = await probeDeployment('https://crove.example.com', fakeFetch(healthy));
    expect(failures(results)).toEqual([]);
    expect(results.map((r) => r.item)).toEqual(['TLS', 'TLS', 'Sign-up limited', 'Email confirmation and MFA step-up']);
    expect(results.find((r) => r.item === 'Sign-up limited')?.message).toBe('the running Supabase Auth refuses new sign-ups (422 signup_disabled)');
  });

  it('accepts a plain-http redirect to https on the same host and refuses plain-http service', async () => {
    const redirectTo = (location: string) => ({ ...healthy, 'http://crove.example.com/healthz': () => new Response(null, { status: 301, headers: { location } }) });
    expect(failures(await probeDeployment('https://crove.example.com', fakeFetch(redirectTo('https://crove.example.com/healthz'))))).toEqual([]);
    for (const location of ['https://elsewhere.example.net/', 'http://crove.example.com/', 'not a url']) {
      expect(failures(await probeDeployment('https://crove.example.com', fakeFetch(redirectTo(location)))).map((r) => r.message), location).toEqual([
        expect.stringContaining('over plain http'),
      ]);
    }
    const served = { ...healthy, 'http://crove.example.com/healthz': json({ ok: true }) };
    expect(failures(await probeDeployment('https://crove.example.com', fakeFetch(served))).map((r) => r.message)).toEqual([expect.stringContaining('over plain http')]);
  });

  it('passes closed plain http only on a refused connection, not on a timeout', async () => {
    const timeout: Fetch = async (input, init) => {
      if (input.startsWith('http:')) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return fakeFetch(healthy)(input, init);
    };
    expect(failures(await probeDeployment('https://crove.example.com', timeout)).map((r) => r.message)).toEqual([expect.stringContaining('could not tell whether http://crove.example.com')]);
  });

  it('probes port 80 for plain http whatever port the https URL uses', async () => {
    const seen: string[] = [];
    const record: Fetch = async (input, init) => {
      seen.push(input);
      return fakeFetch({ 'https://crove.example.com:8443/healthz': json({ ok: true }) })(input, init);
    };
    await probeDeployment('https://crove.example.com:8443', record);
    expect(seen).toContain('http://crove.example.com/healthz');
  });

  it('reports a certificate error and an http origin', async () => {
    const badCert: Fetch = async (input, init) => {
      if (input.endsWith('/healthz') && input.startsWith('https:')) throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) });
      return fakeFetch(healthy)(input, init);
    };
    expect(failures(await probeDeployment('https://crove.example.com', badCert)).map((r) => r.message)).toEqual([expect.stringContaining('CERT_HAS_EXPIRED')]);
    expect(failures(await probeDeployment('http://crove.example.com', fakeFetch({}))).map((r) => r.message)).toEqual([
      'http://crove.example.com is not https',
      expect.stringContaining('could not read the Supabase Auth settings'),
      expect.stringContaining('could not read the Supabase Auth settings'),
    ]);
  });

  it('reads what the running Supabase Auth does', async () => {
    const open = { ...healthy, 'https://crove.example.com/auth/v1/settings': json({ disable_signup: false, mailer_autoconfirm: true }), [SIGNUP]: reachedAuth };
    expect(failures(await probeDeployment('https://crove.example.com', fakeFetch(open))).map((r) => r.item)).toEqual(['Sign-up limited', 'Email confirmation and MFA step-up']);
    // Supabase Auth open behind a restricting kernel (#350) passes when the kernel really refuses the probe.
    const settingsOpen = { ...healthy, 'https://crove.example.com/auth/v1/settings': json({ disable_signup: false, mailer_autoconfirm: false }), [SIGNUP]: reachedAuth };
    expect(failures(await probeDeployment('https://crove.example.com', fakeFetch(settingsOpen))).map((r) => r.item)).toEqual(['Sign-up limited']);
    for (const signupPolicy of ['invite_only', 'allowlist']) {
      const restricted = { ...settingsOpen, 'https://crove.example.com/api/config': json({ authUrl: 'https://crove.example.com/auth/v1', authAnonKey: null, signupPolicy }), [SIGNUP]: refusedByPolicy };
      const results = await probeDeployment('https://crove.example.com', fakeFetch(restricted));
      expect(failures(results)).toEqual([]);
      expect(results.find((r) => r.item === 'Sign-up limited')?.message).toContain(`403 signup_not_allowed, policy ${signupPolicy}`);
    }
    // Every fetch refuses redirects, except the ones that inspect them.
    const modes: (RequestRedirect | undefined)[] = [];
    const record: Fetch = async (input, init) => {
      modes.push(init?.redirect);
      return fakeFetch(healthy)(input, init);
    };
    await probeDeployment('https://crove.example.com', record);
    expect(modes).toEqual(['manual', 'manual', 'error', 'error', 'error']);
  });

  it('trusts a live sign-up probe over the policy the instance reports (#564)', async () => {
    const reported = (signupPolicy: string, signup: Route) => ({
      ...healthy,
      'https://crove.example.com/api/config': json({ authUrl: 'https://crove.example.com/auth/v1', authAnonKey: null, signupPolicy }),
      'https://crove.example.com/auth/v1/settings': json({ disable_signup: false, mailer_autoconfirm: false }),
      [SIGNUP]: signup,
    });
    const signupResult = async (routes: Record<string, Route>) => (await probeDeployment('https://crove.example.com', fakeFetch(routes))).find((r) => r.item === 'Sign-up limited')!;

    // The instance says invite_only, but a sign-up reaches Supabase Auth: not limited.
    const lying = await signupResult(reported('invite_only', reachedAuth));
    expect(lying.status).toBe('fail');
    expect(lying.message).toContain('reached Supabase Auth (400 validation_failed, although /api/config reports the policy invite_only)');
    // Sign-up closed in Supabase Auth passes whatever the policy says.
    expect((await signupResult(reported('open', signupDisabled))).status).toBe('pass');
    // An accepted sign-up fails and names the address to delete.
    const accepted = await signupResult(reported('open', json({ id: 'x' })));
    expect(accepted.status).toBe('fail');
    expect(accepted.message).toMatch(/accepted a sign-up for pilot-check-[0-9a-f]{16}@pilot-check\.invalid/);
    // Answers that prove nothing either way fail as inconclusive, never pass.
    const unknown: Route[] = [
      json({ code: 429, error_code: 'over_email_send_rate_limit' }, 429),
      json({ code: 'AUTH_UNAVAILABLE' }, 503),
      json({ code: 403, error_code: 'something_else' }, 403),
      () => new Response('<html>blocked</html>', { status: 403 }),
      () => new Response('not found', { status: 404 }),
      // A 400 or 422 without Supabase Auth's error code may be a proxy or firewall in front, not Supabase Auth.
      () => new Response('<html>Bad Request</html>', { status: 400 }),
      json({ message: 'unprocessable' }, 422),
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ];
    for (const signup of unknown) {
      const result = await signupResult(reported('invite_only', signup));
      expect(result.status).toBe('fail');
      expect(result.message).toMatch(/^could not tell whether sign-up is limited/);
    }
    expect((await signupResult(reported('invite_only', () => new Response('<html>Bad Request</html>', { status: 400 })))).message).toContain(
      "got 400 without Supabase Auth's error code",
    );
  });

  it('probes with a fresh random address at a reserved domain and no password', async () => {
    const bodies: { email?: unknown }[] = [];
    const record: Fetch = async (input, init) => {
      if (input === SIGNUP) {
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
        bodies.push(JSON.parse(String(init?.body)) as { email?: unknown });
      }
      return fakeFetch(healthy)(input, init);
    };
    await probeDeployment('https://crove.example.com', record);
    await probeDeployment('https://crove.example.com', record);
    expect(bodies.map((b) => Object.keys(b))).toEqual([['email'], ['email']]);
    const [first, second] = bodies.map((b) => b.email);
    expect(first).toMatch(/^pilot-check-[0-9a-f]{16}@pilot-check\.invalid$/);
    expect(first).not.toBe(second);
  });

  it('never fetches an Auth URL the instance names on another origin', async () => {
    for (const authUrl of ['https://auth.example.net/auth/v1', 'http://crove.example.com/auth/v1', 'http://169.254.169.254/latest', 'http://localhost:8080/auth/v1', 'nope']) {
      const seen: string[] = [];
      const record: Fetch = async (input, init) => {
        seen.push(input);
        return fakeFetch({ ...healthy, 'https://crove.example.com/api/config': json({ authUrl }) })(input, init);
      };
      const failed = failures(await probeDeployment('https://crove.example.com', record));
      expect(failed.map((r) => r.item), authUrl).toEqual(['Sign-up limited', 'Email confirmation and MFA step-up']);
      expect(seen.filter((u) => u.endsWith('/settings')), authUrl).toEqual([]);
    }
  });
});

describe('pilot-check command', () => {
  it('parses --url to an origin and refuses anything else', () => {
    expect(parsePilotArgs([])).toEqual({ url: null });
    expect(parsePilotArgs(['--', '--url', 'https://crove.example.com/inbox'])).toEqual({ url: 'https://crove.example.com' });
    for (const argv of [['--url'], ['--url', 'nope'], ['--url', 'ftp://x.example.com'], ['--env']]) expect(() => parsePilotArgs(argv), argv.join(' ')).toThrow();
  });

  it('exits 0 when ready, 1 on a failed check, 2 on bad arguments', async () => {
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    expect(await runPilotCheck([], READY, fakeFetch({}), print)).toBe(PILOT_EXIT.ok);
    expect(lines.join('\n')).toContain('Automatic checks passed. Confirm the 8 manual item(s)');
    expect(await runPilotCheck(['--url', 'https://crove.example.com'], READY, fakeFetch(healthy), print)).toBe(PILOT_EXIT.ok);
    lines.length = 0;
    expect(await runPilotCheck([], { ...READY, AUTH_DISABLE_SIGNUP: 'false' }, fakeFetch({}), print)).toBe(PILOT_EXIT.failed);
    expect(lines.join('\n')).toMatch(/^FAIL +Sign-up limited/m);
    expect(lines.join('\n')).toContain('NOT READY: 1 check(s) failed');
    expect(await runPilotCheck(['--bogus'], READY, fakeFetch({}), print)).toBe(PILOT_EXIT.error);
  });
});

// #1995: the RLS matrix item reads the CI of the build the deployment runs, from GitHub, instead of asking the person.
describe('pilot-check CI of the deployed build (#1995)', () => {
  const SHA = 'a'.repeat(40);
  const VERSION = 'https://crove.example.com/version';
  const CHECKS = `https://api.github.com/repos/DOS/Ludy/commits/${SHA}/check-runs?per_page=100`;
  const run = (name: string, conclusion: string | null = 'success', status = 'completed') => ({ name, status, conclusion });
  const green = [run('Lint, typecheck, test'), run('Database tests (shard 1 of 2)'), run('Database tests (shard 2 of 2)'), run('Database tests (heavy files)'), run('Secret scan')];
  const routes = (checkRuns: unknown[], build: unknown = SHA) => ({ [VERSION]: json({ build, migrationsMissing: [] }), [CHECKS]: json({ total_count: checkRuns.length, check_runs: checkRuns }) });

  it('passes when the gate and every database-test check finished green on that commit', async () => {
    expect(await probeBuildChecks('https://crove.example.com', {}, fakeFetch(routes(green)))).toEqual({
      item: 'RLS matrix',
      status: 'pass',
      message: `CI passed on the deployed build DOS/Ludy@${SHA.slice(0, 12)}: Database tests (heavy files), Database tests (shard 1 of 2), Database tests (shard 2 of 2), Lint, typecheck, test`,
    });
  });

  it('fails naming the checks that did not pass', async () => {
    const red = [...green.slice(0, 1), run('Database tests (shard 1 of 2)', 'failure'), ...green.slice(2)];
    const result = await probeBuildChecks('https://crove.example.com', {}, fakeFetch(routes(red)));
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Database tests (shard 1 of 2) (failure)');
  });

  it('leaves it to the person when it cannot tell', async () => {
    const status = async (r: Record<string, Route>, env: Env = {}) => (await probeBuildChecks('https://crove.example.com', env, fakeFetch(r))).status;
    // Still running, never run, no commit as the build, GitHub refusing, nothing answering.
    expect(await status(routes([...green.slice(1), run('Lint, typecheck, test', null, 'in_progress')]))).toBe('manual');
    expect(await status(routes([run('Secret scan')]))).toBe('manual');
    expect(await status(routes(green, 'dev'))).toBe('manual');
    expect(await status({ [VERSION]: json({ build: SHA }), [CHECKS]: json({ message: 'Not Found' }, 404) })).toBe('manual');
    expect(await status({})).toBe('manual');
    // A source repository that is not owner/name is the operator's mistake.
    for (const repo of ['not a repo', '../x', 'acme/..', 'acme/.']) expect(await status(routes(green), { CROVE_SOURCE_REPO: repo }), repo).toBe('fail');
    // More checks than one page: it cannot tell.
    expect(await status({ [VERSION]: json({ build: SHA }), [CHECKS]: json({ total_count: 140, check_runs: green }) })).toBe('manual');
  });

  it('prints nothing the instance answers but a commit id, and names the rate limit', async () => {
    const result = await probeBuildChecks('https://crove.example.com', {}, fakeFetch(routes(green, '\u001b[32mPASS fake\nline')));
    expect(result.status).toBe('manual');
    expect(result.message).not.toContain('fake');
    // The database down: /version answers 503 but still names the build.
    expect((await probeBuildChecks('https://crove.example.com', {}, fakeFetch({ ...routes(green), [VERSION]: json({ build: SHA, migrationsMissing: null }, 503) }))).status).toBe('pass');
    const limited: Fetch = async (input) => (input === VERSION ? Response.json({ build: SHA }) : new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    expect((await probeBuildChecks('https://crove.example.com', {}, limited)).message).toContain('export GITHUB_TOKEN');
  });

  it('fails a check that was cancelled or skipped, as it is not a pass', async () => {
    for (const conclusion of ['cancelled', 'skipped', 'neutral', 'timed_out']) {
      const result = await probeBuildChecks('https://crove.example.com', {}, fakeFetch(routes([...green.slice(0, 1), run('Database tests (shard 1 of 2)', conclusion), ...green.slice(2)])));
      expect(result.status, conclusion).toBe('fail');
    }
  });

  it('asks the fork CROVE_SOURCE_REPO names, with GITHUB_TOKEN when it is set', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fork = `https://api.github.com/repos/acme/ludy/commits/${SHA}/check-runs?per_page=100`;
    const fetchFn: Fetch = async (input, init) => {
      seen.push({ url: input, auth: new Headers(init?.headers).get('authorization') });
      return input === VERSION ? Response.json({ build: SHA }) : Response.json({ check_runs: green });
    };
    expect((await probeBuildChecks('https://crove.example.com', { CROVE_SOURCE_REPO: 'acme/ludy', GITHUB_TOKEN: 'ghp_test' }, fetchFn)).status).toBe('pass');
    // The token goes to GitHub only, never to the instance.
    expect(seen).toEqual([
      { url: VERSION, auth: null },
      { url: fork, auth: 'Bearer ghp_test' },
    ]);
  });

  it('replaces the manual RLS matrix line of the run with --url', async () => {
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    expect(await runPilotCheck(['--url', 'https://crove.example.com'], READY, fakeFetch({ ...healthy, ...routes(green) }), print)).toBe(PILOT_EXIT.ok);
    const out = lines.join('\n');
    expect(out).toMatch(/^PASS +RLS matrix +CI passed on the deployed build/m);
    expect(out).not.toMatch(/^MANUAL +RLS matrix/m);
  });
});

// #1996: the evidence holds item asks the files bucket for its Object Lock, the way the worker does, when holds are on.
describe('pilot-check evidence holds (#1996)', () => {
  const S3: Env = { STORAGE: 's3', S3_BUCKET: 'crove-files', S3_ENDPOINT: 'https://s3.example.com', S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: fake('s3-secret') };

  it('passes a bucket with Object Lock and fails one without', async () => {
    expect(await probeEvidenceHolds(S3, async () => true)).toMatchObject({ item: 'Evidence holds', status: 'pass' });
    const without = await probeEvidenceHolds(S3, async () => false);
    expect(without).toMatchObject({ item: 'Evidence holds', status: 'fail' });
    expect(without?.message).toContain('crove-files has no Object Lock');
  });

  it('leaves it to the person when the bucket does not answer, naming the permission and never the error text', async () => {
    const denied = Object.assign(new Error('Access Denied for key AKIA... on crove-files'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const result = await probeEvidenceHolds(S3, async () => {
      throw denied;
    });
    expect(result).toMatchObject({ item: 'Evidence holds', status: 'manual' });
    expect(result?.message).toContain('AccessDenied (403)');
    expect(result?.message).toContain('s3:GetBucketObjectLockConfiguration');
    expect(result?.message).not.toContain('AKIA');
  });

  it('asks nothing when holds are off or files are on local disk', async () => {
    const asked = vi.fn(async () => true);
    expect(await probeEvidenceHolds({ ...S3, EVIDENCE_LOCK_DAYS: '0' }, asked)).toBeNull();
    expect(await probeEvidenceHolds({ ...S3, STORAGE: 'local' }, asked)).toBeNull();
    expect(await probeEvidenceHolds({}, asked)).toBeNull();
    expect(await probeEvidenceHolds({ ...S3, S3_BUCKET: '' }, asked)).toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });

  it('names the network code of an unreachable bucket, and the permission only when the call is refused', async () => {
    const unreachable = Object.assign(new Error('getaddrinfo ENOTFOUND minio'), { cause: { code: 'ENOTFOUND' } });
    const result = await probeEvidenceHolds(S3, async () => {
      throw unreachable;
    });
    expect(result).toMatchObject({ status: 'manual' });
    expect(result?.message).toContain('(Error (ENOTFOUND))');
    expect(result?.message).not.toContain('s3:GetBucketObjectLockConfiguration');
  });

  it('gives up on a bucket that does not answer within the probe timeout', async () => {
    vi.useFakeTimers();
    try {
      const pending = probeEvidenceHolds(S3, () => new Promise<boolean>(() => {}));
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result).toMatchObject({ status: 'manual' });
      expect(result?.message).toContain('(Timeout)');
    } finally {
      vi.useRealTimers();
    }
  });

  // A fake S3 client: answers GetObjectLockConfiguration as told and records every command it is sent.
  const fakeS3 = (answer: () => unknown) => {
    const sent: Array<{ name: string; input: unknown }> = [];
    const client = {
      send: async (command: { constructor: { name: string }; input: unknown }) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return answer();
      },
    } as unknown as S3Sender;
    return { client, sent };
  };
  const s3Error = (name: string, status: number) => Object.assign(new Error(`${name} for key AKIA-not-printed`), { name, $metadata: { httpStatusCode: status } });
  const run = async (client: S3Sender) => {
    const lines: string[] = [];
    await runPilotCheck([], { ...READY, ...S3 }, fakeFetch({}), (line) => lines.push(line), objectLockProbe(client));
    return lines.join('\n');
  };

  it('replaces the manual line of the run with what the bucket answers, writing nothing to it', async () => {
    const on = fakeS3(() => ({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }));
    const passed = await run(on.client);
    expect(passed).toMatch(/^PASS +Evidence holds +the files bucket crove-files has Object Lock enabled/m);
    expect(passed).not.toMatch(/^MANUAL +Evidence holds/m);
    // One read of the bucket's configuration, nothing else: no object is written, held or deleted.
    expect(on.sent).toEqual([{ name: 'GetObjectLockConfigurationCommand', input: { Bucket: 'crove-files' } }]);

    const off = fakeS3(() => {
      throw s3Error('ObjectLockConfigurationNotFoundError', 404);
    });
    expect(await run(off.client)).toMatch(/^FAIL +Evidence holds +the files bucket crove-files has no Object Lock/m);
    expect(await run(fakeS3(() => ({ ObjectLockConfiguration: {} })).client)).toMatch(/^FAIL +Evidence holds/m);

    const denied = await run(fakeS3(() => {
      throw s3Error('AccessDenied', 403);
    }).client);
    expect(denied).toMatch(/^MANUAL +Evidence holds +could not read the Object Lock of the files bucket crove-files \(AccessDenied \(403\); the keys need s3:GetBucketObjectLockConfiguration on it\)/m);
    expect(denied).not.toContain('AKIA');
    // A missing bucket is no answer either, not "no Object Lock".
    expect(await run(fakeS3(() => {
      throw s3Error('NoSuchBucket', 404);
    }).client)).toMatch(/^MANUAL +Evidence holds .*NoSuchBucket \(404\)/m);
  });
});
