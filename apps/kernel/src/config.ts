import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  // Loopback by default; the Docker image sets 0.0.0.0 and compose publishes the port on loopback.
  HOST: z.string().default('127.0.0.1'),
  // Number of reverse proxies in front of Crove whose X-Forwarded-For entries are trusted (0 = none).
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  DATABASE_URL: z.string().min(1),
  WORKER_DATABASE_URL: optional,
  // Reset each pooled connection's session before it goes back to the pool (#117, plan §3.3). Keep true for direct
  // connections (self-host); set false only behind a transaction-mode pooler (PgBouncer, Supavisor), where the reset
  // would reach another server connection and the pooler's own reset governs.
  DB_RESET_ON_RELEASE: z.enum(['true', 'false']).default('true'),
  ADMIN_DATABASE_URL: optional,
  MIGRATIONS_DIR: z.string().default(here('../../../supabase/migrations')),
  WEB_DIST: z.string().default(here('../../app/dist')),
  // Blob storage (External-tenant gate T7): local disk under STORAGE_DIR, or any S3-compatible store. The API
  // and the worker must point at the same store; with s3 they need no shared volume.
  STORAGE: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default(here('../../../.data/files')),
  // Unset for AWS S3; the server's URL for MinIO, Cloudflare R2 or GCS interoperability.
  S3_ENDPOINT: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // R2 uses auto.
  S3_REGION: optional.transform((v) => v ?? 'us-east-1'),
  S3_BUCKET: optional.pipe(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/)
      .optional(),
  ),
  // Both or neither: without them the SDK's default chain applies (environment, instance or workload identity).
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  // Path-style URLs (endpoint/bucket/key), needed by MinIO and most self-hosted servers.
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  // Supabase Auth (GoTrue). Self-host: the kernel proxies /auth/v1 to AUTH_UPSTREAM_URL.
  AUTH_UPSTREAM_URL: optional,
  PUBLIC_AUTH_URL: optional,
  PUBLIC_AUTH_ANON_KEY: optional,
  AUTH_JWT_SECRET: optional,
  AUTH_JWKS_URL: optional,
  // Required (ADR-0028): the `iss` every access token must carry. Bundled Supabase Auth: GOTRUE_JWT_ISSUER.
  AUTH_ISSUER: optional,
  AUTH_AUDIENCE: z.string().default('authenticated'),
  // Session status source (ADR-0028): db reads Supabase Auth's tables in the shared database (self-host); jwt
  // (Crove Cloud, or any remote Supabase Auth) trusts the verified token until its exp, plus Crove's own session
  // records, and confirms every R3 command live with Supabase Auth; off checks only Crove's own records and never
  // calls Auth (local URLs only). Unset: db when AUTH_UPSTREAM_URL is set (bundled Supabase Auth), jwt otherwise.
  AUTH_SESSION_CHECK: z.enum(['db', 'jwt', 'off']).optional(),
  // Policy P11: R3 needs MFA in the last 5 minutes. off is accepted on local URLs only.
  AUTH_STEP_UP: z.enum(['required', 'off']).default('required'),
  // Mirrors GOTRUE_MAILER_AUTOCONFIRM so the kernel can refuse unsafe public deployments.
  AUTH_AUTOCONFIRM: z.enum(['true', 'false']).default('false'),
  // Per-client budget for the emails the bundled Supabase Auth sends (sign-up confirmation, recovery, magic link and
  // OTP codes, resend, email change, reauthentication), enforced by the /auth/v1 proxy in the database across API
  // instances (#190): at most AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR per client address (IPv6: per /64) in any rolling
  // hour, and one per recipient every AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS. AUTH_RATE_LIMIT_EMAIL_SENT is Supabase
  // Auth's deployment-wide budget (GOTRUE_RATE_LIMIT_EMAIL_SENT, per hour); when set, a public deployment refuses to
  // start unless it takes at least EMAIL_BUDGET_MIN_CLIENTS client addresses to use it up.
  AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(5),
  AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  AUTH_RATE_LIMIT_EMAIL_SENT: optional
    .transform((v) => (v === undefined ? undefined : Number(v)))
    .pipe(z.number().int().min(1).max(1_000_000).optional()),
  // Per-user limits on creating orgs (External-tenant gate T4), enforced in the database across API instances:
  // at most ORG_CREATE_LIMIT_PER_DAY in any rolling 24 hours and ORG_CREATE_LIMIT_TOTAL ever (closed orgs count).
  ORG_CREATE_LIMIT_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(5),
  ORG_CREATE_LIMIT_TOTAL: z.coerce.number().int().min(1).max(999_999).default(20),
  // Per-org limits on rotating the inbound email address (#113), enforced in the database across API instances:
  // at most INBOUND_ROTATE_LIMIT_PER_DAY in any rolling 24 hours and INBOUND_ROTATE_LIMIT_TOTAL ever. Every rotation
  // leaves a permanent tombstone, so the total bounds the ledger.
  INBOUND_ROTATE_LIMIT_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(3),
  INBOUND_ROTATE_LIMIT_TOTAL: z.coerce.number().int().min(1).max(999_999).default(50),
  // Bound on denied/failed audit rows (issue #162), counted in the database across API instances: in each fixed
  // window of REFUSAL_AUDIT_WINDOW_SECONDS, an actor's refusals get an audit row until the actor has
  // REFUSAL_AUDIT_LIMIT_PER_ACTOR or the org REFUSAL_AUDIT_LIMIT_PER_ORG refusals in it; later ones are only counted
  // (crove_kernel.refusal_tally). The first refusal of each command and code of an actor in a window is always audited.
  REFUSAL_AUDIT_LIMIT_PER_ACTOR: z.coerce.number().int().min(1).max(999_999).default(50),
  REFUSAL_AUDIT_LIMIT_PER_ORG: z.coerce.number().int().min(1).max(999_999).default(500),
  REFUSAL_AUDIT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  // Requests per minute per signed-in user on /api (429 RATE_LIMITED with Retry-After past it), per API process; see
  // rate-limit.ts. 0 turns it off, for a deployment whose edge (proxy, CDN or WAF) limits per user instead.
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(999_999).default(600),
  // Any OpenAI-compatible endpoint. Without it, e-invoice XML still works; PDF/images do not.
  AI_BASE_URL: optional,
  AI_API_KEY: optional,
  AI_MODEL: optional,
  AI_STRUCTURED_OUTPUTS: z.enum(['true', 'false']).default('true'),
  // crove-extract, the parsing sandbox (plan §7.6, External-tenant gate T12), e.g. http://crove-extract:8090.
  // Required for the worker role: the worker never parses PDF, XML or MIME itself. The API role does not use it.
  EXTRACT_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // Outbound mail (invites, issue #129), the same SMTP settings the bundled Supabase Auth uses. Unset SMTP_HOST: mail
  // is off, and the inviter passes the link on. Port 465 is implicit TLS; with SMTP_USER and SMTP_PASS on any other
  // port the server must offer STARTTLS.
  SMTP_HOST: optional,
  // An empty value (SMTP_PORT= in a .env) means the default.
  SMTP_PORT: optional.transform((v) => (v === undefined ? 587 : Number(v))).pipe(z.number().int().min(1).max(65_535)),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  SMTP_FROM: optional,
  // Inbound email: <token>@INBOUND_DOMAIN, delivered by a mail worker to POST /api/inbound/email.
  INBOUND_DOMAIN: optional,
  INBOUND_SECRET: optional,
  // Role passwords applied by `migrate` (self-host).
  CROVE_APP_DB_PASSWORD: optional,
  CROVE_WORKER_DB_PASSWORD: optional,
  // The prober's login (crove_prober); it may only execute crove_kernel.health().
  CROVE_PROBER_DB_PASSWORD: optional,
  AUTH_DB_PASSWORD: optional,
});

export type SessionCheckMode = 'db' | 'jwt' | 'off';

export type Config = Omit<z.infer<typeof schema>, 'AUTH_ISSUER' | 'AUTH_SESSION_CHECK'> & {
  AUTH_ISSUER: string;
  AUTH_SESSION_CHECK: SessionCheckMode;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid configuration: ${fields}`);
  }
  const raw = parsed.data;
  if (!raw.AUTH_ISSUER) {
    throw new Error('set AUTH_ISSUER to the issuer of your Supabase Auth access tokens (bundled: GOTRUE_JWT_ISSUER)');
  }
  const config: Config = {
    ...raw,
    AUTH_ISSUER: raw.AUTH_ISSUER,
    AUTH_SESSION_CHECK: raw.AUTH_SESSION_CHECK ?? (raw.AUTH_UPSTREAM_URL ? 'db' : 'jwt'),
  };
  if (!config.AUTH_JWT_SECRET && !config.AUTH_JWKS_URL) {
    throw new Error('set AUTH_JWT_SECRET (self-hosted Supabase Auth) or AUTH_JWKS_URL (hosted Supabase Auth)');
  }
  if (config.AUTH_JWT_SECRET && config.AUTH_JWT_SECRET.length < 32) {
    throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
  }
  if (config.INBOUND_SECRET && config.INBOUND_SECRET.length < 32) {
    throw new Error('INBOUND_SECRET must be at least 32 characters');
  }
  if (config.STORAGE === 's3' && !config.S3_BUCKET) throw new Error('STORAGE=s3 needs S3_BUCKET');
  if (Boolean(config.S3_ACCESS_KEY_ID) !== Boolean(config.S3_SECRET_ACCESS_KEY)) {
    throw new Error('set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither to use the default credential chain');
  }
  if (config.SMTP_HOST && !config.SMTP_FROM) throw new Error('SMTP_HOST needs SMTP_FROM, the sender address of Crove mails');
  if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASS)) throw new Error('set both SMTP_USER and SMTP_PASS, or neither');
  if (!isLocalUrl(config.PUBLIC_URL)) {
    if (config.AUTH_JWT_SECRET && SAMPLE_SECRETS.has(config.AUTH_JWT_SECRET)) {
      throw new Error('AUTH_JWT_SECRET is a sample value; generate a random secret before exposing Crove');
    }
    if (config.AUTH_AUTOCONFIRM === 'true') {
      throw new Error('AUTH_AUTOCONFIRM=true lets anyone claim any email address; set it to false and configure SMTP');
    }
    if (config.AUTH_SESSION_CHECK === 'off') {
      throw new Error('AUTH_SESSION_CHECK=off keeps signed-out sessions working; use db (bundled Supabase Auth) or jwt');
    }
    if (config.AUTH_SESSION_CHECK === 'jwt' && !liveAuthUrl(config)) {
      throw new Error('AUTH_SESSION_CHECK=jwt confirms R3 actions with Supabase Auth; set PUBLIC_AUTH_URL (or AUTH_UPSTREAM_URL)');
    }
    if (config.AUTH_STEP_UP === 'off') {
      throw new Error('AUTH_STEP_UP=off lets a stolen session approve and change roles without MFA; set it to required');
    }
    const budget = config.AUTH_RATE_LIMIT_EMAIL_SENT;
    if (config.AUTH_UPSTREAM_URL && budget !== undefined && config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR * EMAIL_BUDGET_MIN_CLIENTS > budget) {
      throw new Error(
        `AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR=${config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR} lets ${Math.ceil(budget / config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR)} ` +
          `client addresses use up the email budget (AUTH_RATE_LIMIT_EMAIL_SENT=${budget}); keep it at most ` +
          `${Math.floor(budget / EMAIL_BUDGET_MIN_CLIENTS)}, or raise the budget`,
      );
    }
  }
  // Hosted Supabase refuses requests without the project's publishable key, which would turn every R3 into a 401.
  const live = config.AUTH_SESSION_CHECK === 'jwt' ? liveAuthUrl(config) : null;
  if (live && !config.PUBLIC_AUTH_ANON_KEY && isHostedSupabase(live)) {
    throw new Error('hosted Supabase Auth needs PUBLIC_AUTH_ANON_KEY (the publishable key) for the R3 live check');
  }
  return config;
}

// How many client addresses it must take, at least, to use up Supabase Auth's deployment-wide email budget.
export const EMAIL_BUDGET_MIN_CLIENTS = 10;

// Values shipped in docker-compose.yml and .env.example. Fine on localhost, never on a public URL.
const SAMPLE_SECRETS = new Set(['local-only-jwt-secret-change-me-0123456789', 'change-me-to-a-long-random-string-0123456789']);

function isHostedSupabase(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.supabase.co');
  } catch {
    return false;
  }
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function publicAuthUrl(config: Config): string {
  return config.PUBLIC_AUTH_URL ?? `${config.PUBLIC_URL.replace(/\/$/, '')}/auth/v1`;
}

// Where the kernel confirms a session live with Supabase Auth (GET /user, ADR-0028 section 5): the bundled Auth
// directly when it is proxied, otherwise the Auth URL the SPA signs in with. null: not configured.
export function liveAuthUrl(config: Config): string | null {
  return config.AUTH_UPSTREAM_URL ?? config.PUBLIC_AUTH_URL ?? null;
}
