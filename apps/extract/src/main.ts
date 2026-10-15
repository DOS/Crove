// crove-extract entry point (plan §7.6, External-tenant gate T12). The service must run with no credentials:
// it refuses to start when its environment holds anything that looks like one.
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { EXTRACT_LIMITS } from '@crove/extract-contract';
import { createExtractApp } from './server.ts';

const schema = z.object({
  PORT: z.coerce.number().int().positive().max(65_535).default(8090),
  // Loopback by default; the image sets 0.0.0.0 and compose keeps the port on an internal network.
  HOST: z.string().default('127.0.0.1'),
  EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  EXTRACT_MAX_QUEUE: z.coerce.number().int().min(0).max(100).default(2),
  EXTRACT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  EXTRACT_MAX_HEAP_MB: z.coerce.number().int().min(64).max(4096).default(512),
});

export type ExtractConfig = z.infer<typeof schema>;

// Variable names that carry credentials or point at places holding data. Only names are ever reported.
const CREDENTIAL_NAME =
  /SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|DATABASE_URL|_DSN$|^(AWS|GOOGLE|GCP|AZURE|S3|SUPABASE)_/i;

export function credentialVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && env[name] !== '' && CREDENTIAL_NAME.test(name))
    .sort();
}

// In production (NODE_ENV=production, set by the image) credentials refuse the start. In development the shell
// often holds unrelated tokens; the parser processes never see them (empty environment), so this only warns.
export function loadExtractConfig(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): ExtractConfig {
  const credentials = credentialVariables(env);
  if (credentials.length > 0) {
    const message = `crove-extract must run without credentials; remove ${credentials.join(', ')} from its environment`;
    if (env.NODE_ENV === 'production') throw new Error(message);
    warn(`[extract] ${message} (development: continuing; parser processes get an empty environment)`);
  }
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return parsed.data;
}

function main() {
  const config = loadExtractConfig();
  const app = createExtractApp({
    concurrency: config.EXTRACT_CONCURRENCY,
    maxQueue: config.EXTRACT_MAX_QUEUE,
    sandbox: {
      timeoutMs: config.EXTRACT_TIMEOUT_MS,
      maxHeapMb: config.EXTRACT_MAX_HEAP_MB,
      maxOutputBytes: EXTRACT_LIMITS.maxResponseBytes,
    },
  });
  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST });
  console.log(`[extract] listening on ${config.HOST}:${config.PORT}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
