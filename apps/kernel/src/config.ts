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
  // Session status source (ADR-0028): db reads Supabase Auth's tables in the shared database (self-host), events
  // consumes lifecycle events (Crove Cloud), off checks only Crove's own record (local URLs only). Unset: db when
  // AUTH_UPSTREAM_URL is set (bundled Supabase Auth), events otherwise; never "no check".
  AUTH_SESSION_CHECK: z.enum(['db', 'events', 'off']).optional(),
  // Policy P11: R3 needs MFA in the last 5 minutes. off is accepted on local URLs only.
  AUTH_STEP_UP: z.enum(['required', 'off']).default('required'),
  // Mirrors GOTRUE_MAILER_AUTOCONFIRM so the kernel can refuse unsafe public deployments.
  AUTH_AUTOCONFIRM: z.enum(['true', 'false']).default('false'),
  // Per-user limits on creating orgs (External-tenant gate T4), enforced in the database across API instances:
  // at most ORG_CREATE_LIMIT_PER_DAY in any rolling 24 hours and ORG_CREATE_LIMIT_TOTAL ever (closed orgs count).
  ORG_CREATE_LIMIT_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(5),
  ORG_CREATE_LIMIT_TOTAL: z.coerce.number().int().min(1).max(999_999).default(20),
  // Any OpenAI-compatible endpoint. Without it, e-invoice XML still works; PDF/images do not.
  AI_BASE_URL: optional,
  AI_API_KEY: optional,
  AI_MODEL: optional,
  AI_STRUCTURED_OUTPUTS: z.enum(['true', 'false']).default('true'),
  // Inbound email: <token>@INBOUND_DOMAIN, delivered by a mail worker to POST /api/inbound/email.
  INBOUND_DOMAIN: optional,
  INBOUND_SECRET: optional,
  // Role passwords applied by `migrate` (self-host).
  CROVE_APP_DB_PASSWORD: optional,
  CROVE_WORKER_DB_PASSWORD: optional,
  AUTH_DB_PASSWORD: optional,
});

export type SessionCheckMode = 'db' | 'events' | 'off';

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
    AUTH_SESSION_CHECK: raw.AUTH_SESSION_CHECK ?? (raw.AUTH_UPSTREAM_URL ? 'db' : 'events'),
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
  if (!isLocalUrl(config.PUBLIC_URL)) {
    if (config.AUTH_JWT_SECRET && SAMPLE_SECRETS.has(config.AUTH_JWT_SECRET)) {
      throw new Error('AUTH_JWT_SECRET is a sample value; generate a random secret before exposing Crove');
    }
    if (config.AUTH_AUTOCONFIRM === 'true') {
      throw new Error('AUTH_AUTOCONFIRM=true lets anyone claim any email address; set it to false and configure SMTP');
    }
    if (config.AUTH_SESSION_CHECK === 'off') {
      throw new Error('AUTH_SESSION_CHECK=off keeps signed-out sessions working; use db (bundled Supabase Auth) or events');
    }
    if (config.AUTH_STEP_UP === 'off') {
      throw new Error('AUTH_STEP_UP=off lets a stolen session approve and change roles without MFA; set it to required');
    }
  }
  return config;
}

// Values shipped in docker-compose.yml and .env.example. Fine on localhost, never on a public URL.
const SAMPLE_SECRETS = new Set(['local-only-jwt-secret-change-me-0123456789', 'change-me-to-a-long-random-string-0123456789']);

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
