// The `pilot-check` image role (issue #308, backlog review 2026-10-17 M1-8): a preflight for a deployment that a
// consenting design partner will use. It reads the deployment's settings (the .env that docker compose reads) and,
// with --url, probes the running instance. It fails loudly on anything the pilot readiness checklist forbids and lists
// the items only a person can confirm (docs/runbooks/pilot-readiness.md).
//
//   pilot-check [--url https://crove.example.com]
//
// Exit codes: 0 every automatic check passed, 1 a check failed, 2 the check could not run (bad arguments).
import { parseExportKey } from './export-seal.ts';

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
  add('TLS', tls, 'PUBLIC_URL and the other browser-facing URLs are https');

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
  // Optional secrets: only a shipped sample value is wrong.
  for (const name of ['INBOUND_SECRET', 'S3_SECRET_ACCESS_KEY', 'SMTP_PASS', 'AI_API_KEY', 'CREDENTIAL_KEY', 'CHANNEL_META_APP_SECRET']) {
    if (name === 'INBOUND_SECRET' && value(env, 'INBOUND_DOMAIN')) continue;
    const secret = value(env, name);
    if (secret && (KNOWN_DEFAULTS.has(secret) || /change-?me/i.test(secret))) secrets.push(`${name} still has a sample value`);
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

  // Sign-up closed: the bundled Supabase Auth refuses new accounts (GOTRUE_DISABLE_SIGNUP).
  const signup = value(env, 'AUTH_DISABLE_SIGNUP');
  add(
    'Sign-up limited',
    [
      signup === 'true'
        ? null
        : `AUTH_DISABLE_SIGNUP is ${signup ?? 'unset'}: anyone who reaches PUBLIC_URL can create an account; set AUTH_DISABLE_SIGNUP=true once the partner's accounts exist (docs/runbooks/pilot-readiness.md)`,
    ],
    'AUTH_DISABLE_SIGNUP=true: Supabase Auth creates no new accounts',
  );

  results.push(
    {
      item: 'Extraction sandbox',
      status: 'manual',
      message: 'no setting turns it off (the worker refuses to start without EXTRACT_URL); confirm crove-extract is running and healthy: docker compose ps crove-extract',
    },
    {
      item: 'RLS matrix',
      status: 'manual',
      message: 'confirm the CI db job and the invariant suite (rls-matrix.db.test.ts, T8) are green on the commit you deploy',
    },
    { item: 'Backups', status: 'manual', message: 'confirm a restore drill passed (M1-7, issue #307)' },
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

/** Probes the running deployment at `origin`: TLS, no plain-http service, and the sign-up settings Supabase Auth reports. */
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
    const { authUrl } = (await config.json()) as { authUrl?: unknown };
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
      settings.disable_signup === true
        ? { item: 'Sign-up limited', status: 'pass', message: 'the running Supabase Auth refuses new sign-ups' }
        : { item: 'Sign-up limited', status: 'fail', message: 'the running Supabase Auth accepts sign-ups from anyone (disable_signup is not true)' },
      settings.mailer_autoconfirm === false
        ? { item: 'Email confirmation and MFA step-up', status: 'pass', message: 'the running Supabase Auth requires email confirmation' }
        : { item: 'Email confirmation and MFA step-up', status: 'fail', message: 'the running Supabase Auth skips email confirmation (mailer_autoconfirm is not false)' },
    );
  } catch (error) {
    authFailed(`could not read the Supabase Auth settings: ${reason(error)}`);
  }
  return results;
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
  const results = checkEnv(env);
  if (args.url) results.push(...(await probeDeployment(args.url, fetchFn)));
  print(formatResults(results));
  return results.some((r) => r.status === 'fail') ? PILOT_EXIT.failed : PILOT_EXIT.ok;
}
