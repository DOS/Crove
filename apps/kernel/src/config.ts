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
  STORAGE_DIR: z.string().default(here('../../../.data/files')),
  // Supabase Auth (GoTrue). Self-host: the kernel proxies /auth/v1 to AUTH_UPSTREAM_URL.
  AUTH_UPSTREAM_URL: optional,
  PUBLIC_AUTH_URL: optional,
  PUBLIC_AUTH_ANON_KEY: optional,
  AUTH_JWT_SECRET: optional,
  AUTH_JWKS_URL: optional,
  AUTH_ISSUER: optional,
  AUTH_AUDIENCE: z.string().default('authenticated'),
  // Mirrors GOTRUE_MAILER_AUTOCONFIRM so the kernel can refuse unsafe public deployments.
  AUTH_AUTOCONFIRM: z.enum(['true', 'false']).default('false'),
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

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid configuration: ${fields}`);
  }
  const config = parsed.data;
  if (!config.AUTH_JWT_SECRET && !config.AUTH_JWKS_URL) {
    throw new Error('set AUTH_JWT_SECRET (self-hosted Supabase Auth) or AUTH_JWKS_URL (hosted Supabase Auth)');
  }
  if (config.AUTH_JWT_SECRET && config.AUTH_JWT_SECRET.length < 32) {
    throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
  }
  if (config.INBOUND_SECRET && config.INBOUND_SECRET.length < 32) {
    throw new Error('INBOUND_SECRET must be at least 32 characters');
  }
  if (!isLocalUrl(config.PUBLIC_URL)) {
    if (config.AUTH_JWT_SECRET && SAMPLE_SECRETS.has(config.AUTH_JWT_SECRET)) {
      throw new Error('AUTH_JWT_SECRET is a sample value; generate a random secret before exposing Crove');
    }
    if (config.AUTH_AUTOCONFIRM === 'true') {
      throw new Error('AUTH_AUTOCONFIRM=true lets anyone claim any email address; set it to false and configure SMTP');
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
