// The `pilot-check` image role (issue #308, backlog review 2026-10-17 M1-8): a preflight for a deployment that a
// consenting design partner will use. It reads the deployment's settings (the .env that docker compose reads) and,
// with --url, probes the running instance. It fails loudly on anything the pilot readiness checklist forbids and lists
// the items only a person can confirm (docs/runbooks/pilot-readiness.md).
//
//   pilot-check [--url https://crove.example.com]
//
// Exit codes: 0 every automatic check passed, 1 a check failed, 2 the check could not run (bad arguments).
import { randomBytes } from 'node:crypto';
import { parseVaultKey } from '@crove/kernel-runtime';
import { parseExportKey } from './export-seal.ts';
import { loadProberConfig } from './prober.ts';

export const PILOT_EXIT = { ok: 0, failed: 1, error: 2 } as const;

export type CheckStatus = 'pass' | 'fail' | 'manual';

export interface CheckResult {
  /** The checklist item of issue #308 this result belongs to. */
  item: string;
  status: CheckStatus;
  message: string;
}

export interface PilotArgs {
  url: string | null;
}

export type Env = Readonly<Record<string, string | undefined>>;

// Secrets every pilot deployment sets, with the sample values shipped in .env.example and the fallbacks
// docker-compose.yml and docker-compose.split.yml use when a variable is unset. pilot-check.test.ts keeps these lists
// in step with those files.
export const REQUIRED_SECRETS = [
  'POSTGRES_PASSWORD',
  'CROVE_APP_DB_PASSWORD',
  'CROVE_WORKER_DB_PASSWORD',
  'CROVE_PROBER_DB_PASSWORD',
  'CROVE_REPORTER_DB_PASSWORD',
  'AUTH_DB_PASSWORD',
  'AUTH_JWT_SECRET',
  'EXPORT_ENCRYPTION_KEY',
] as const;

export const KNOWN_DEFAULTS: ReadonlySet<string> = new Set([
  // .env.example
  'change-me-postgres',
  'change-me-app',
  'change-me-worker',
  'change-me-prober',
  'change-me-reporter',
  'change-me-auth',
  'change-me-to-a-long-random-string-0123456789',
  // docker-compose.yml fallbacks
  'local-postgres-password',
  'local-app-password',
  'local-worker-password',
  'local-prober-password',
  'local-reporter-password',
  'local-auth-password',
  'local-only-jwt-secret-change-me-0123456789',
  // docker-compose.split.yml (a local test stack)
  'split-stack-inbound-secret-0123456789abcdef',
  'crove-split-minio-secret',
]);

// Shortest value accepted for a database password; AUTH_JWT_SECRET and INBOUND_SECRET need 32 (the kernel's own rule).
const MIN_PASSWORD_LENGTH = 16;
const MIN_TOKEN_SECRET_LENGTH = 32;

export function parsePilotArgs(argv: readonly string[]): PilotArgs {
  const args: PilotArgs = { url: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm pilot:check -- --url ...` passes the separator on.
    if (arg === '--') continue;
    if (arg === '--url') {
      const raw = argv[++i] ?? '';
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error('--url needs the public URL of the deployment, such as https://crove.example.com');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('--url needs an http(s) URL');
      args.url = url.origin;
    } else throw new Error(`unknown pilot-check argument ${arg}; use --url <public URL>`);
  }
  return args;
}

function value(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.startsWith('127.');
}

function httpsProblem(name: string, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${name} is not a URL (${raw})`;
  }
  if (url.protocol !== 'https:') return `${name} is ${url.origin}: browsers must reach it over https`;
  if (isLocalHost(url.hostname)) return `${name} is ${url.origin}: a loopback address is not reachable by the partner`;
  return null;
}

// A URL that carries its own secret (a webhook's token or path, a heartbeat check's id) goes over https only.
function secretUrlProblem(name: string, raw: string): string | null {
  if (!URL.canParse(raw)) return `${name} is not a URL`;
  if (new URL(raw).protocol !== 'https:') return `${name} is not https: the URL carries its secret (a bot token, a webhook path, a check id)`;
  return null;
}

function secretProblem(name: string, secret: string | undefined, minLength: number): string | null {
  if (secret === undefined) return `${name} is unset (docker compose then falls back to a value published in this repository)`;
  if (KNOWN_DEFAULTS.has(secret) || /change-?me/i.test(secret)) return `${name} still has a sample value from .env.example or docker-compose.yml`;
  if (secret.length < minLength) return `${name} is shorter than ${minLength} characters`;
  return null;
}

/** Checks the deployment's settings (the .env docker compose reads, or the environment of a non-compose deploy). */
export function checkEnv(env: Env): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (item: string, problems: (string | null)[], ok: string) => {
    const found = problems.filter((p): p is string => p !== null);
    if (found.length === 0) results.push({ item, status: 'pass', message: ok });
    else for (const message of found) results.push({ item, status: 'fail', message });
  };

  // TLS: every URL a browser of the partner opens.
  const tls: (string | null)[] = [];
  const publicUrl = value(env, 'PUBLIC_URL');
  tls.push(publicUrl ? httpsProblem('PUBLIC_URL', publicUrl) : 'PUBLIC_URL is unset (docker compose then uses http://localhost:8080)');
  const authUrl = value(env, 'PUBLIC_AUTH_URL');
  if (authUrl) tls.push(httpsProblem('PUBLIC_AUTH_URL', authUrl));
  // Presigned transfers send files from the browser straight to the bucket (S3_PUBLIC_ENDPOINT, else S3_ENDPOINT;
  // AWS S3 itself when both are empty, which is https).
  if (value(env, 'STORAGE') === 's3' && value(env, 'S3_PRESIGNED_URLS') !== 'false') {
    const browserEndpoint = value(env, 'S3_PUBLIC_ENDPOINT') ?? value(env, 'S3_ENDPOINT');
    if (browserEndpoint) tls.push(httpsProblem(value(env, 'S3_PUBLIC_ENDPOINT') ? 'S3_PUBLIC_ENDPOINT' : 'S3_ENDPOINT', browserEndpoint));
  }
  // The kernel serves plain http, so a pilot always has a TLS reverse proxy in front. With TRUSTED_PROXY_HOPS=0 every
  // client then shares the proxy's address and so one email budget (#190): a few refused sign-ups or mistyped
  // addresses from anyone use up the confirmation and recovery emails of everyone for an hour (#564).
  const hops = value(env, 'TRUSTED_PROXY_HOPS');
  if (hops === undefined || !/^[1-5]$/.test(hops)) {
    tls.push(
      `TRUSTED_PROXY_HOPS is ${hops ?? 'unset (0)'}: behind the TLS reverse proxy every client would share its address, and so one email budget and one sign-in rate limit; set it to the number of proxies that append X-Forwarded-For (1 for the Caddy setup in docs/runbooks/provision-pilot.md)`,
    );
  }
  add('TLS', tls, 'PUBLIC_URL and the other browser-facing URLs are https, and TRUSTED_PROXY_HOPS counts the reverse proxy in front');

  // Secrets: none left at a value this public repository ships.
  const secrets: (string | null)[] = REQUIRED_SECRETS.map((name) =>
    secretProblem(name, value(env, name), name === 'AUTH_JWT_SECRET' ? MIN_TOKEN_SECRET_LENGTH : name === 'EXPORT_ENCRYPTION_KEY' ? 0 : MIN_PASSWORD_LENGTH),
  );
  const exportKey = value(env, 'EXPORT_ENCRYPTION_KEY');
  if (exportKey && !KNOWN_DEFAULTS.has(exportKey)) {
    try {
      parseExportKey(exportKey);
    } catch {
      secrets.push('EXPORT_ENCRYPTION_KEY is not 32 bytes as base64 or hex (openssl rand -base64 32)');
    }
  }
  if (value(env, 'INBOUND_DOMAIN')) secrets.push(secretProblem('INBOUND_SECRET', value(env, 'INBOUND_SECRET'), MIN_TOKEN_SECRET_LENGTH));
  // The previous inbound secret of a rotation (#1214), under the current one's rules, and never the same value. Its
  // value is never printed.
  const inboundPrevious = value(env, 'INBOUND_SECRET_PREVIOUS');
  if (inboundPrevious !== undefined) {
    secrets.push(secretProblem('INBOUND_SECRET_PREVIOUS', inboundPrevious, MIN_TOKEN_SECRET_LENGTH));
    // The kernel refuses to start on either (config.ts).
    if (value(env, 'INBOUND_SECRET') === undefined) secrets.push('INBOUND_SECRET_PREVIOUS is set without INBOUND_SECRET');
    else if (inboundPrevious === value(env, 'INBOUND_SECRET')) secrets.push('INBOUND_SECRET_PREVIOUS is the same as INBOUND_SECRET');
  }
  // Optional secrets: only a shipped sample value is wrong.
  for (const name of ['INBOUND_SECRET', 'S3_SECRET_ACCESS_KEY', 'SMTP_PASS', 'AI_API_KEY', 'CREDENTIAL_KEY', 'CREDENTIAL_KEY_PREVIOUS', 'CHANNEL_META_APP_SECRET', 'CHANNEL_ZALO_APP_SECRET', 'CHANNEL_THREADS_APP_SECRET', 'CHANNEL_LINKEDIN_CLIENT_SECRET', 'CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET', 'CHANNEL_GOOGLE_CLIENT_SECRET', 'CHANNEL_TIKTOK_CLIENT_SECRET', 'CHANNEL_X_CLIENT_SECRET', 'CHANNEL_PINTEREST_APP_SECRET', 'MEDIA_PEXELS_API_KEY', 'VAPID_PRIVATE_KEY']) {
    if (name === 'INBOUND_SECRET' && value(env, 'INBOUND_DOMAIN')) continue;
    const secret = value(env, name);
    if (secret && (KNOWN_DEFAULTS.has(secret) || /change-?me/i.test(secret))) secrets.push(`${name} still has a sample value`);
  }
  // The credential keys (ADR-0025): a key that does not parse stops the API and the worker; the ids of those that do
  // name what the worker opens, for the manual line below (#1888).
  // Without CREDENTIAL_KEY the current key is the key file's, which the preflight does not read.
  const credentialKeys: string[] = value(env, 'CREDENTIAL_KEY') ? [] : ['the key in CREDENTIAL_KEY_FILE (docker compose: /data/keys/credential.key on the keys volume)'];
  for (const name of ['CREDENTIAL_KEY', 'CREDENTIAL_KEY_PREVIOUS']) {
    const key = value(env, name);
    // A sample value is failed above, as for every optional secret.
    if (!key || KNOWN_DEFAULTS.has(key) || /change-?me/i.test(key)) continue;
    try {
      credentialKeys.push(`${name} (${parseVaultKey(key).id})`);
    } catch {
      secrets.push(`${name} is not a 32-byte key as base64 or 64 hex characters (openssl rand -base64 32)`);
    }
  }
  add('Secrets', secrets, 'the database passwords, AUTH_JWT_SECRET and EXPORT_ENCRYPTION_KEY are set, and no secret is a shipped sample value');

  // Email confirmation and MFA step-up. docker-compose.yml falls back to AUTH_AUTOCONFIRM=true, so it must be set.
  const auth: (string | null)[] = [];
  const autoconfirm = value(env, 'AUTH_AUTOCONFIRM');
  if (autoconfirm !== 'false') {
    auth.push(
      autoconfirm === undefined
        ? 'AUTH_AUTOCONFIRM is unset: docker compose then skips email confirmation (true); set AUTH_AUTOCONFIRM=false'
        : `AUTH_AUTOCONFIRM=${autoconfirm}: anyone can claim any email address; set AUTH_AUTOCONFIRM=false`,
    );
  }
  const smtpHost = value(env, 'SMTP_HOST');
  if (!smtpHost || ['smtp.example.com', 'mailpit', 'mailhog'].includes(smtpHost) || isLocalHost(smtpHost)) {
    auth.push(`SMTP_HOST is ${smtpHost ?? 'unset (docker compose then uses the local Mailpit)'}: with confirmations on, set a real SMTP server or nobody can confirm an email`);
  }
  const stepUp = value(env, 'AUTH_STEP_UP');
  if (stepUp !== undefined && stepUp !== 'required') auth.push(`AUTH_STEP_UP=${stepUp}: approvals and member changes must need MFA; set AUTH_STEP_UP=required`);
  add('Email confirmation and MFA step-up', auth, 'AUTH_AUTOCONFIRM=false with an SMTP server, and AUTH_STEP_UP=required');

  // Sign-up closed (the bundled Supabase Auth refuses new accounts, GOTRUE_DISABLE_SIGNUP), or limited by the kernel's
  // /auth/v1 proxy to invited emails or allowed domains (AUTH_SIGNUP_POLICY, #350).
  const signup = value(env, 'AUTH_DISABLE_SIGNUP');
  const policy = value(env, 'AUTH_SIGNUP_POLICY');
  const domains = value(env, 'AUTH_SIGNUP_ALLOWED_DOMAINS');
  const restricted = policy === 'invite_only' || (policy === 'allowlist' && domains !== undefined);
  add(
    'Sign-up limited',
    [
      signup === 'true' || restricted
        ? null
        : `AUTH_DISABLE_SIGNUP is ${signup ?? 'unset'} and AUTH_SIGNUP_POLICY is ${policy ?? 'unset'}${policy === 'allowlist' ? ' without AUTH_SIGNUP_ALLOWED_DOMAINS' : ''}: anyone who reaches PUBLIC_URL can create an account; set AUTH_SIGNUP_POLICY=invite_only, or AUTH_DISABLE_SIGNUP=true once the partner's accounts exist (docs/runbooks/pilot-readiness.md)`,
    ],
    signup === 'true' ? 'AUTH_DISABLE_SIGNUP=true: Supabase Auth creates no new accounts' : `AUTH_SIGNUP_POLICY=${policy}: Crove forwards only sign-ups it admits`,
  );

  // Alerts (M1-9, issue #309): the prober posts to a channel the owner reads, and it runs.
  const alerts: (string | null)[] = [];
  const webhook = value(env, 'ALERT_WEBHOOK_URL');
  alerts.push(
    webhook
      ? secretUrlProblem('ALERT_WEBHOOK_URL', webhook)
      : 'ALERT_WEBHOOK_URL is unset: the prober prints alerts to its own log, where nobody reads them; set a Telegram or Slack webhook the owner reads (docs/runbooks/alerts.md)',
  );
  const heartbeat = value(env, 'PROBER_HEARTBEAT_URL');
  if (heartbeat) alerts.push(secretUrlProblem('PROBER_HEARTBEAT_URL', heartbeat));
  // The prober's own rules (a Telegram webhook needs the chat id, limits are whole numbers), once the URLs are sound.
  if (!alerts.some((p) => p !== null)) {
    try {
      loadProberConfig({ ...env });
    } catch (error) {
      alerts.push(error instanceof Error ? error.message : String(error));
    }
  }
  const proberProfile = (value(env, 'COMPOSE_PROFILES') ?? '').split(',').some((p) => p.trim() === 'prober');
  // The message is built before the problems are known: never parse a webhook that may not be a URL.
  const webhookHost = webhook && URL.canParse(webhook) ? new URL(webhook).host : 'the webhook';
  add('Alerts', alerts, `alerts go to ${webhookHost}${proberProfile ? ', from the prober the compose profile starts' : ''}`);

  // Backups (M1-7, issues #307 and #351): copied to a second location, over https, apart from the files bucket.
  const backups: (string | null)[] = [];
  const backupEndpoint = value(env, 'BACKUP_S3_ENDPOINT');
  const backupBucket = value(env, 'BACKUP_S3_BUCKET');
  if (!backupEndpoint) {
    backups.push("BACKUP_S3_ENDPOINT is unset: the nightly backups stay on the server's own disk, which is not a backup; set a bucket at another provider or account (docs/runbooks/backup-and-restore.md)");
  } else if (!URL.canParse(backupEndpoint)) {
    backups.push('BACKUP_S3_ENDPOINT is not a URL');
  } else {
    const url = new URL(backupEndpoint);
    if (url.protocol !== 'https:') backups.push(`BACKUP_S3_ENDPOINT is ${url.origin}: the backups and their keys would travel in the clear; use https`);
    else if (isLocalHost(url.hostname)) backups.push(`BACKUP_S3_ENDPOINT is ${url.origin}: a bucket on this server is not a second location`);
    for (const name of ['BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY']) {
      if (!value(env, name)) backups.push(`${name} is unset: backup.sh needs it with BACKUP_S3_ENDPOINT`);
    }
    const filesEndpoint = value(env, 'S3_ENDPOINT') ?? 'https://s3.amazonaws.com';
    if (value(env, 'STORAGE') === 's3' && backupBucket === value(env, 'S3_BUCKET') && URL.canParse(filesEndpoint) && new URL(filesEndpoint).host === url.host) {
      backups.push('BACKUP_S3_BUCKET is the files bucket itself: one incident would take both; use another provider or account');
    }
  }
  const backupKey = value(env, 'BACKUP_ENCRYPTION_KEY');
  if (backupKey) {
    try {
      const parsed = parseExportKey(backupKey);
      let sameAsExport = false;
      try {
        sameAsExport = exportKey !== undefined && parseExportKey(exportKey).equals(parsed);
      } catch {
        // An invalid export key is reported under Secrets.
      }
      if (sameAsExport) backups.push('BACKUP_ENCRYPTION_KEY is EXPORT_ENCRYPTION_KEY: give each its own key (openssl rand -base64 32)');
    } catch {
      backups.push('BACKUP_ENCRYPTION_KEY is not 32 bytes as base64 or hex (openssl rand -base64 32)');
    }
  }
  const backupHeartbeat = value(env, 'BACKUP_HEARTBEAT_URL');
  if (backupHeartbeat) backups.push(secretUrlProblem('BACKUP_HEARTBEAT_URL', backupHeartbeat));
  const backupHost = backupEndpoint && URL.canParse(backupEndpoint) ? new URL(backupEndpoint).host : 'the bucket';
  add('Backups', backups, `backups go to ${backupHost}, bucket ${backupBucket ?? '?'}, ${backupKey ? 'sealed with BACKUP_ENCRYPTION_KEY' : 'not sealed'}`);

  results.push(
    {
      item: 'Alerts',
      status: 'manual',
      message:
        'an outside monitor requests PUBLIC_URL/healthz every 5 minutes and pages the owner, and the test alert (pnpm alert:test) reached the phone (docs/runbooks/alerts.md)',
    },
    ...(proberProfile
      ? []
      : [{ item: 'Alerts', status: 'manual' as const, message: 'COMPOSE_PROFILES does not include prober: confirm a cron job runs the prober every 5 minutes (README, "Monitoring and alerts")' }]),
    ...(heartbeat
      ? []
      : [
          {
            item: 'Alerts',
            status: 'manual' as const,
            message: 'PROBER_HEARTBEAT_URL is unset: nothing pages the owner when the prober itself stops or cannot deliver; set it (docs/runbooks/alerts.md) or accept that',
          },
        ]),
    // A rotation of the inbound secret left half done keeps the old value working (#1214).
    ...(inboundPrevious === undefined
      ? []
      : [
          {
            item: 'Secrets',
            status: 'manual' as const,
            message:
              'INBOUND_SECRET_PREVIOUS is set: an inbound secret rotation is under way and the old value is still accepted; once the mail worker sends the new INBOUND_SECRET, remove it and restart (docs/runbooks/secret-rotation.md, section 2)',
          },
        ]),
    // Envelopes under a key the worker cannot open (#1888): only the worker sees the database's key ids, so it logs them.
    {
      item: 'Credential key',
      status: 'manual',
      message:
        `the worker opens tokens sealed under ${credentialKeys.length > 0 ? credentialKeys.join(' and ') : 'no valid key (see Secrets)'}; ` +
        'confirm its log since its last start has no "[credential-reseal] ERROR sealed under a key this worker cannot open" line (docker compose logs crove | grep "cannot open"; ' +
        'the worker service with docker-compose.split.yml): the key was lost, or CREDENTIAL_KEY_PREVIOUS removed before every channel token and team chat target was resealed (docs/runbooks/credential-key.md)',
    },
    {
      item: 'Extraction sandbox',
      status: 'manual',
      message: 'no setting turns it off (the worker refuses to start without EXTRACT_URL); confirm crove-extract is running and healthy: docker compose ps crove-extract',
    },
    {
      item: 'RLS matrix',
      status: 'manual',
      message: `${RLS_MANUAL} (with --url, pilot-check reads them from GitHub)`,
    },
    ...(backupKey
      ? []
      : [
          {
            item: 'Backups',
            status: 'manual' as const,
            message: 'BACKUP_ENCRYPTION_KEY is unset: whoever can read the backup bucket can read the books; set it (kept apart from the bucket, docs/runbooks/backup-and-restore.md) or accept that',
          },
        ]),
    ...(backupHeartbeat
      ? []
      : [
          {
            item: 'Backups',
            status: 'manual' as const,
            message: 'BACKUP_HEARTBEAT_URL is unset: nothing pages the owner when the nightly backup stops running; set it (docs/runbooks/backup-and-restore.md) or accept that',
          },
        ]),
    {
      item: 'Backups',
      status: 'manual',
      message: 'confirm a restore onto a scratch stack passed this month (restore.sh ends with "restore of <run> passed") and note the RPO and RTO it shows (docs/runbooks/backup-and-restore.md)',
    },
    // Evidence holds (#1009): the worker can hold posted invoice files only on an S3 bucket with Object Lock, which
    // nothing here can see; without it, it logs one ALERT a day and posting goes on.
    {
      item: 'Evidence holds',
      status: 'manual',
      message:
        value(env, 'STORAGE') === 's3' && Number(value(env, 'EVIDENCE_LOCK_DAYS') ?? '3650') > 0
          ? 'confirm the files bucket has Object Lock enabled and the worker log shows no "[evidence-hold] ALERT" (docs/runbooks/evidence-holds.md)'
          : 'posted invoice files get no retention hold (STORAGE is not s3, or EVIDENCE_LOCK_DAYS=0): confirm the owner accepts that (docs/runbooks/evidence-holds.md)',
    },
    { item: 'Owner sign-off', status: 'manual', message: 'the owner records the sign-off in issue #308' },
  );
  return results;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const PROBE_TIMEOUT_MS = 10_000;

// Connection errors that mean nothing listens on the port. A timeout or a DNS failure proves nothing.
const CLOSED_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET']);

function isHttpsOn(location: string | null, hostname: string): boolean {
  if (!location || !URL.canParse(location)) return false;
  const target = new URL(location);
  return target.protocol === 'https:' && target.hostname === hostname;
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    if (typeof code === 'string') return code;
    if (cause instanceof Error) return cause.message;
    return error.message;
  }
  return String(error);
}

/** Probes the running deployment at `origin`: TLS, no plain-http service, a sign-up nobody may make, and email confirmation. */
export async function probeDeployment(origin: string, fetchFn: Fetch = fetch): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const url = new URL(origin);
  const init = (extra: RequestInit = {}): RequestInit => ({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), ...extra });

  if (url.protocol !== 'https:') {
    results.push({ item: 'TLS', status: 'fail', message: `${origin} is not https` });
  } else {
    // fetch verifies the certificate chain and the host name; a self-signed or expired certificate fails here. No
    // redirect is followed: a redirect elsewhere would test another host's certificate.
    try {
      const response = await fetchFn(`${origin}/healthz`, init({ redirect: 'manual' }));
      results.push(
        response.ok
          ? { item: 'TLS', status: 'pass', message: `${origin}/healthz answers over https with a valid certificate` }
          : { item: 'TLS', status: 'fail', message: `${origin}/healthz answered ${response.status}` },
      );
    } catch (error) {
      results.push({ item: 'TLS', status: 'fail', message: `${origin}/healthz failed over https: ${reason(error)}` });
    }
    // Plain http on port 80 must refuse the connection or redirect to https on the same host, never serve the app.
    const plain = new URL(origin);
    plain.protocol = 'http:';
    plain.port = '';
    try {
      const response = await fetchFn(`${plain.origin}/healthz`, init({ redirect: 'manual' }));
      const redirected = response.status >= 300 && response.status < 400 && isHttpsOn(response.headers.get('location'), url.hostname);
      results.push(
        redirected
          ? { item: 'TLS', status: 'pass', message: `${plain.origin} redirects to https` }
          : { item: 'TLS', status: 'fail', message: `${plain.origin}/healthz answered ${response.status} over plain http; redirect it to https on the same host or close port 80` },
      );
    } catch (error) {
      const code = reason(error);
      results.push(
        CLOSED_CODES.has(code)
          ? { item: 'TLS', status: 'pass', message: `${plain.origin} refuses connections (plain http is closed)` }
          : { item: 'TLS', status: 'fail', message: `could not tell whether ${plain.origin} serves plain http (${code}); check port 80 by hand` },
      );
    }
  }

  // Supabase Auth's public settings: what the running auth service really does, whatever .env says. The app's
  // /api/config names the Auth URL the SPA signs in with; for the pilot that is the bundled one behind /auth/v1 on the
  // same origin. The probe never follows that URL elsewhere: it is data from the instance, not from the operator.
  const authFailed = (message: string) => {
    for (const item of ['Sign-up limited', 'Email confirmation and MFA step-up']) results.push({ item, status: 'fail', message });
  };
  try {
    const config = await fetchFn(`${origin}/api/config`, init({ redirect: 'error' }));
    if (!config.ok) throw new Error(`${origin}/api/config answered ${config.status}`);
    const { authUrl, signupPolicy } = (await config.json()) as { authUrl?: unknown; signupPolicy?: unknown };
    if (typeof authUrl !== 'string' || !URL.canParse(authUrl)) throw new Error(`${origin}/api/config names no valid authUrl`);
    const auth = new URL(authUrl);
    if (auth.origin !== url.origin) {
      authFailed(`the Auth URL ${auth.origin} is not on ${url.origin}: check Supabase Auth's sign-up and confirmation settings by hand`);
      return results;
    }
    const response = await fetchFn(`${authUrl.replace(/\/$/, '')}/settings`, init({ redirect: 'error' }));
    if (!response.ok) throw new Error(`${authUrl}/settings answered ${response.status}`);
    const settings = (await response.json()) as { disable_signup?: unknown; mailer_autoconfirm?: unknown };
    results.push(
      await probeSignup(authUrl, typeof signupPolicy === 'string' ? signupPolicy : null, fetchFn, init),
      settings.mailer_autoconfirm === false
        ? { item: 'Email confirmation and MFA step-up', status: 'pass', message: 'the running Supabase Auth requires email confirmation' }
        : { item: 'Email confirmation and MFA step-up', status: 'fail', message: 'the running Supabase Auth skips email confirmation (mailer_autoconfirm is not false)' },
    );
  } catch (error) {
    authFailed(`could not read the Supabase Auth settings: ${reason(error)}`);
  }
  return results;
}

// The sign-up probe (#564): what the running instance does with a sign-up nobody may make, rather than what
// /api/config and /settings say about it. It signs up a random address at a reserved domain that never resolves
// (RFC 2606 .invalid), which no allowlist holds and no invite names, and sends no password:
//   - Crove's proxy enforcing invite_only or allowlist refuses it before Supabase Auth (403 signup_not_allowed). It
//     creates nothing and sends nothing; it uses one slot of this client's email budget for the hour.
//   - Supabase Auth with sign-up closed refuses it (signup_disabled).
//   - Otherwise it reaches Supabase Auth, which refuses a sign-up without a password before it creates or mails
//     anything (validation_failed, checked against the pinned image by e2e/tests/auth-signup-parity.spec.ts): sign-up is
//     open to anyone.
// Any other answer (a rate limit, a server error, a timeout) proves nothing either way, and says so.
async function probeSignup(authUrl: string, reportedPolicy: string | null, fetchFn: Fetch, init: (extra?: RequestInit) => RequestInit): Promise<CheckResult> {
  const item = 'Sign-up limited';
  const address = `pilot-check-${randomBytes(8).toString('hex')}@pilot-check.invalid`;
  const cannotTell = (why: string): CheckResult => ({
    item,
    status: 'fail',
    message: `could not tell whether sign-up is limited: ${why}; run pilot-check again later, or check by hand that a sign-up for an address outside the policy is refused with 403 signup_not_allowed`,
  });
  let response: Response;
  try {
    response = await fetchFn(
      `${authUrl.replace(/\/$/, '')}/signup`,
      init({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: address }) }),
    );
  } catch (error) {
    return cannotTell(`the sign-up probe failed (${reason(error)})`);
  }
  const answer = (await response.json().catch(() => null)) as { error_code?: unknown } | null;
  const code = typeof answer?.error_code === 'string' ? answer.error_code : null;
  const got = `${response.status}${code ? ` ${code}` : ''}`;
  if (response.status === 403 && code === 'signup_not_allowed') {
    return { item, status: 'pass', message: `the running Crove refused a sign-up for a random address no policy admits (403 signup_not_allowed${reportedPolicy ? `, policy ${reportedPolicy}` : ''})` };
  }
  if (code === 'signup_disabled') return { item, status: 'pass', message: `the running Supabase Auth refuses new sign-ups (${got})` };
  if (response.ok) {
    return {
      item,
      status: 'fail',
      message: `the running instance accepted a sign-up for ${address} (${got}): anyone who reaches it can create an account; delete that account and set AUTH_SIGNUP_POLICY (docs/runbooks/pilot-readiness.md)`,
    };
  }
  // Supabase Auth's own refusal of the body (its error shape, 400 or 422): the request got past every sign-up gate.
  if ((response.status === 400 || response.status === 422) && code !== null) {
    return {
      item,
      status: 'fail',
      message: `a sign-up for a random address reached Supabase Auth (${got}${reportedPolicy === 'invite_only' || reportedPolicy === 'allowlist' ? `, although /api/config reports the policy ${reportedPolicy}` : ''}): anyone who reaches the instance can create an account; set AUTH_SIGNUP_POLICY=invite_only or AUTH_DISABLE_SIGNUP=true and recreate the services (docs/runbooks/pilot-readiness.md)`,
    };
  }
  if (response.status === 429) return cannotTell(`the sign-up probe was rate limited (${got})`);
  // A 400 or 422 without Supabase Auth's error code may come from a reverse proxy or firewall in front, so it proves
  // nothing about the sign-up gates. Still a failure: an inconclusive probe never passes.
  if (response.status === 400 || response.status === 422) {
    return cannotTell(`the sign-up probe got ${got} without Supabase Auth's error code, so something in front of it (a reverse proxy or firewall) may have answered`);
  }
  return cannotTell(`the sign-up probe got ${got}`);
}

const LABEL: Record<CheckStatus, string> = { pass: 'PASS  ', fail: 'FAIL  ', manual: 'MANUAL' };

export function formatResults(unordered: readonly CheckResult[]): string {
  // What the tool decided first, then what a person must confirm.
  const results = [...unordered.filter((r) => r.status !== 'manual'), ...unordered.filter((r) => r.status === 'manual')];
  const width = Math.max(...results.map((r) => r.item.length));
  const lines = results.map((r) => `${LABEL[r.status]}  ${r.item.padEnd(width)}  ${r.message}`);
  const failed = results.filter((r) => r.status === 'fail').length;
  const manual = results.filter((r) => r.status === 'manual').length;
  lines.push(
    '',
    failed > 0
      ? `NOT READY: ${failed} check(s) failed. Fix them before the design partner uses this deployment.`
      : `Automatic checks passed. Confirm the ${manual} manual item(s) before the owner signs off (docs/runbooks/pilot-readiness.md).`,
  );
  return lines.join('\n');
}

// The source repository whose CI ran the commit a deployment reports (#1995): DOS/Ludy unless CROVE_SOURCE_REPO names a
// fork, as owner/name.
export const DEFAULT_SOURCE_REPO = 'DOS/Ludy';
// The checks of the ci workflow that hold the RLS matrix and the rest of the database tests (T8), and the gate that
// gathers them with lint, typecheck and the unit tests; on main they run on every push.
const DATABASE_CHECKS = /^Database tests\b/;
const GATE_CHECK = 'Lint, typecheck, test';
const RLS_MANUAL = 'confirm the CI db job and the invariant suite (rls-matrix.db.test.ts, T8) are green on the commit you deploy';

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * Whether CI passed on the build the deployment runs (#1995): the commit /version reports, the ci workflow's database
 * tests (the RLS matrix among them) and its gate, read from GitHub's API for the source repository. PASS when all
 * finished green, FAIL naming the ones that did not, MANUAL when it cannot tell (no build id, a commit GitHub does not
 * know, checks still running, the API out of reach): the person checks by hand, as before. GITHUB_TOKEN, when set,
 * raises the API's rate limit; a public repository needs none.
 */
export async function probeBuildChecks(origin: string, env: Env, fetchFn: Fetch = fetch): Promise<CheckResult> {
  const manual = (why: string): CheckResult => ({ item: 'RLS matrix', status: 'manual', message: `${why}: ${RLS_MANUAL}` });
  const init = (extra: RequestInit = {}): RequestInit => ({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), ...extra });
  const repo = value(env, 'CROVE_SOURCE_REPO') ?? DEFAULT_SOURCE_REPO;
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) return { item: 'RLS matrix', status: 'fail', message: `CROVE_SOURCE_REPO is owner/name of a GitHub repository, not ${repo}` };
  let build: string;
  try {
    const response = await fetchFn(`${origin}/version`, init({ redirect: 'error' }));
    if (!response.ok) return manual(`${origin}/version answered ${response.status}`);
    const answer = (await response.json()) as { build?: unknown };
    if (typeof answer.build !== 'string' || !/^[0-9a-f]{40}$/.test(answer.build)) return manual(`the instance reports no commit as its build (${String(answer.build ?? 'none')})`);
    build = answer.build;
  } catch (error) {
    return manual(`${origin}/version failed: ${reason(error)}`);
  }
  const short = build.slice(0, 12);
  const token = value(env, 'GITHUB_TOKEN');
  let runs: CheckRun[];
  try {
    const response = await fetchFn(
      `https://api.github.com/repos/${repo}/commits/${build}/check-runs?per_page=100`,
      init({ redirect: 'error', headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) } }),
    );
    if (!response.ok) return manual(`GitHub answered ${response.status} for the checks of ${repo}@${short}`);
    runs = ((await response.json()) as { check_runs?: CheckRun[] }).check_runs ?? [];
  } catch (error) {
    return manual(`could not read the checks of ${repo}@${short} from GitHub: ${reason(error)}`);
  }
  const wanted = runs.filter((r) => DATABASE_CHECKS.test(r.name) || r.name === GATE_CHECK);
  if (!wanted.some((r) => r.name === GATE_CHECK) || !wanted.some((r) => DATABASE_CHECKS.test(r.name))) {
    return manual(`${repo}@${short} has no ${GATE_CHECK} or database-test check (a commit CI never ran)`);
  }
  const failed = wanted.filter((r) => r.status === 'completed' && r.conclusion !== 'success').map((r) => `${r.name} (${r.conclusion ?? 'no conclusion'})`);
  if (failed.length > 0) return { item: 'RLS matrix', status: 'fail', message: `CI did not pass on the deployed build ${repo}@${short}: ${[...new Set(failed)].sort().join(', ')}` };
  if (wanted.some((r) => r.status !== 'completed')) return manual(`CI is still running on the deployed build ${repo}@${short}`);
  return { item: 'RLS matrix', status: 'pass', message: `CI passed on the deployed build ${repo}@${short}: ${[...new Set(wanted.map((r) => r.name))].sort().join(', ')}` };
}

export async function runPilotCheck(
  argv: readonly string[],
  env: Env = process.env,
  fetchFn: Fetch = fetch,
  print: (line: string) => void = console.log,
): Promise<number> {
  let args: PilotArgs;
  try {
    args = parsePilotArgs(argv);
  } catch (error) {
    print(`[pilot-check] ${error instanceof Error ? error.message : String(error)}`);
    return PILOT_EXIT.error;
  }
  let results = checkEnv(env);
  if (args.url) {
    results.push(...(await probeDeployment(args.url, fetchFn)));
    // The CI of the deployed build (#1995) replaces the manual RLS matrix line.
    const ci = await probeBuildChecks(args.url, env, fetchFn);
    results = [...results.filter((r) => !(r.item === 'RLS matrix' && r.status === 'manual')), ci];
  }
  print(formatResults(results));
  return results.some((r) => r.status === 'fail') ? PILOT_EXIT.failed : PILOT_EXIT.ok;
}
