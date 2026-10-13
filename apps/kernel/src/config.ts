import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
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
  return config;
}

export function publicAuthUrl(config: Config): string {
  return config.PUBLIC_AUTH_URL ?? `${config.PUBLIC_URL.replace(/\/$/, '')}/auth/v1`;
}
