// crove-extract entry point (plan §7.6, External-tenant gate T12). The service must run with no credentials: in
// production it refuses to start when its environment holds any variable outside an explicit allowlist.
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { EXTRACT_CLIENT_TIMEOUT_MS, EXTRACT_LIMITS, EXTRACT_TIMING, worstCaseCallMs } from '@crove/extract-contract';
import { DEFAULT_SANDBOX } from './sandbox.ts';
import { createExtractApp } from './server.ts';

const schema = z.object({
  PORT: z.coerce.number().int().positive().max(65_535).default(8090),
  // Loopback by default; the image sets 0.0.0.0 and compose keeps the port on an internal network.
  HOST: z.string().default('127.0.0.1'),
  EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(EXTRACT_TIMING.concurrency),
  EXTRACT_MAX_QUEUE: z.coerce.number().int().min(0).max(100).default(EXTRACT_TIMING.maxQueue),
  EXTRACT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(EXTRACT_TIMING.parseTimeoutMs),
  EXTRACT_MAX_HEAP_MB: z.coerce.number().int().min(64).max(4096).default(DEFAULT_SANDBOX.maxHeapMb),
  // Resident memory of one parser process, Buffers and wasm included (the heap limit does not cover them).
  EXTRACT_MAX_RSS_MB: z.coerce.number().int().min(64).max(8192).default(DEFAULT_SANDBOX.maxRssMb),
});

export type ExtractConfig = z.infer<typeof schema>;

// Variable names that carry credentials or point at places holding data. Only names are ever reported.
const CREDENTIAL_NAME =
  /SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|DATABASE_URL|_DSN$|^(AWS|GOOGLE|GCP|AZURE|S3|SUPABASE)_/i;

// Every variable the production image may hold: its own settings, the ones the node image sets and the ones the
// container runtime adds. Anything else (a credential under any name, NODE_OPTIONS, a proxy, a service link)
// refuses the start, so nothing reaches the service by mistake.
export const ALLOWED_VARIABLES: ReadonlySet<string> = new Set([
  ...Object.keys(schema.shape),
  'NODE_ENV',
  // node:26-slim
  'NODE_VERSION',
  'YARN_VERSION',
  // Docker and other OCI runtimes
  'PATH',
  'HOME',
  'HOSTNAME',
  'TERM',
  'container',
]);

export function credentialVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && env[name] !== '' && CREDENTIAL_NAME.test(name))
    .sort();
}

// Names outside ALLOWED_VARIABLES, set even to an empty value. Only names are ever reported.
export function unexpectedVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && !ALLOWED_VARIABLES.has(name))
    .sort();
}

// In production (NODE_ENV=production, set by the image) any variable outside the allowlist refuses the start. In
// development the shell holds many unrelated variables and often tokens; the parser processes never see them
// (empty environment), so credential-like names only warn there.
export function loadExtractConfig(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): ExtractConfig {
  if (env.NODE_ENV === 'production') {
    const unexpected = unexpectedVariables(env);
    if (unexpected.length > 0) {
      throw new Error(`crove-extract runs with its own settings only; remove ${unexpected.join(', ')} from its environment`);
    }
  } else {
    const credentials = credentialVariables(env);
    if (credentials.length > 0) {
      warn(
        `[extract] crove-extract must run without credentials; remove ${credentials.join(', ')} from its environment (development: continuing; parser processes get an empty environment)`,
      );
    }
  }
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const config = parsed.data;
  // The worker gives up after EXTRACT_CLIENT_TIMEOUT_MS; a queued request must finish its parse before that.
  const worst = worstCaseCallMs({
    parseTimeoutMs: config.EXTRACT_TIMEOUT_MS,
    concurrency: config.EXTRACT_CONCURRENCY,
    maxQueue: config.EXTRACT_MAX_QUEUE,
    transferSlackMs: EXTRACT_TIMING.transferSlackMs,
  });
  if (worst > EXTRACT_CLIENT_TIMEOUT_MS) {
    throw new Error(
      `EXTRACT_TIMEOUT_MS, EXTRACT_MAX_QUEUE and EXTRACT_CONCURRENCY allow a call of ${worst} ms, longer than the worker waits (${EXTRACT_CLIENT_TIMEOUT_MS} ms)`,
    );
  }
  return config;
}

function main() {
  const config = loadExtractConfig();
  const app = createExtractApp({
    concurrency: config.EXTRACT_CONCURRENCY,
    maxQueue: config.EXTRACT_MAX_QUEUE,
    sandbox: {
      timeoutMs: config.EXTRACT_TIMEOUT_MS,
      maxHeapMb: config.EXTRACT_MAX_HEAP_MB,
      maxRssMb: config.EXTRACT_MAX_RSS_MB,
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
