// Crove kernel entry point. One image, several roles:
//   migrate      apply SQL migrations, set role passwords, create the job schema
//   auth-grants  after Supabase Auth has started: let the session check read auth.sessions and auth.users
//   api          HTTP API + web UI
//   worker   outbox relay + jobs
//   all      api + worker in one process (default for self-host)
import { serve } from '@hono/node-server';
import { InvoiceExtractor } from '@crove/agent';
import { assertRlsEnforced, assertSystemContextAccess, createDb, createPool } from '@crove/db';
import { applyAuthGrants, migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from './auth.ts';
import { loadConfig, type Config } from './config.ts';
import { createHttpApp } from './http.ts';
import { createSessionRevoker, createSessionStatusSource } from './sessions.ts';
import { createBlobStore, describeStorage } from './storage.ts';
import { migrateJobs, startWorker } from './worker.ts';

type Role = 'migrate' | 'auth-grants' | 'api' | 'worker' | 'all';
const ROLES: readonly Role[] = ['migrate', 'auth-grants', 'api', 'worker', 'all'];

function buildRuntime(config: Config, connectionString: string, applicationName: string) {
  const pool = createPool({ connectionString, applicationName, max: 10 });
  const db = createDb(pool);
  const runtime = new Runtime(db, {
    // Every user request is checked against its session (ADR-0028); the config never resolves to "no check".
    sessions: createSessionStatusSource(config.AUTH_SESSION_CHECK),
    stepUp: config.AUTH_STEP_UP,
  }).register({
    commands: [
      ...buildKernelCommands({ orgCreateLimits: { perDay: config.ORG_CREATE_LIMIT_PER_DAY, total: config.ORG_CREATE_LIMIT_TOTAL } }),
      ...financeCommands,
    ],
    queries: [...kernelQueries({ inboundDomain: config.INBOUND_DOMAIN ?? null }), ...financeQueries],
  });
  return { pool, db, runtime };
}

function buildExtractor(config: Config): InvoiceExtractor | null {
  if (!config.AI_BASE_URL || !config.AI_MODEL) return null;
  return new InvoiceExtractor({
    baseURL: config.AI_BASE_URL,
    apiKey: config.AI_API_KEY ?? null,
    model: config.AI_MODEL,
    supportsStructuredOutputs: config.AI_STRUCTURED_OUTPUTS === 'true',
  });
}

async function runMigrate(config: Config) {
  const adminUrl = config.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is required for migrate');
  const applied = await migrate({ adminUrl, dir: config.MIGRATIONS_DIR, log: (m) => console.log(`[migrate] ${m}`) });
  await setRolePasswords(adminUrl, {
    crove_app: config.CROVE_APP_DB_PASSWORD,
    crove_worker: config.CROVE_WORKER_DB_PASSWORD,
    supabase_auth_admin: config.AUTH_DB_PASSWORD,
  });
  await migrateJobs(adminUrl);
  console.log(`[migrate] done, ${applied.length} new migration(s)`);
}

async function runAuthGrants(config: Config) {
  const adminUrl = config.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is required for auth-grants');
  await applyAuthGrants({ adminUrl, log: (m) => console.log(`[auth-grants] ${m}`) });
}

async function main() {
  const role = (process.argv[2] ?? 'all') as Role;
  if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
  const config = loadConfig();
  if (role === 'migrate') return runMigrate(config);
  if (role === 'auth-grants') return runAuthGrants(config);
  console.log(`[auth] session check: ${config.AUTH_SESSION_CHECK}, step-up for R3: ${config.AUTH_STEP_UP}`);
  // The worker alone enters system context, so it never shares the API's login role (External-tenant gate T5).
  const workerUrl = config.WORKER_DATABASE_URL;
  if ((role === 'worker' || role === 'all') && !workerUrl) {
    throw new Error('WORKER_DATABASE_URL is required for the worker; connect it as crove_worker');
  }

  // API and worker build the same store from config; with STORAGE=s3 they share no volume (T7).
  const store = createBlobStore(config);
  console.log(`[storage] ${describeStorage(config)}`);
  const stops: Array<() => Promise<void>> = [];

  if (role === 'api' || role === 'all') {
    const { pool, db, runtime } = buildRuntime(config, config.DATABASE_URL, 'crove-api');
    await assertRlsEnforced(pool);
    await assertSystemContextAccess(pool, 'denied');
    const authenticate = createAuthenticator(config, db);
    const app = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: buildExtractor(config) !== null });
    const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST });
    console.log(`[api] listening on ${config.HOST}:${config.PORT}`);
    stops.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    });
  }

  if ((role === 'worker' || role === 'all') && workerUrl) {
    const connectionString = workerUrl;
    const { pool, db, runtime } = buildRuntime(config, connectionString, 'crove-worker');
    await assertRlsEnforced(pool);
    await assertSystemContextAccess(pool, 'granted');
    const stop = await startWorker({
      connectionString,
      workerDb: db,
      runtime,
      store,
      extractor: buildExtractor(config),
      inboundDomain: config.INBOUND_DOMAIN ?? null,
      revoker: createSessionRevoker(config),
    });
    stops.push(async () => {
      await stop();
      await pool.end();
    });
  }

  const shutdown = async () => {
    for (const stop of stops.reverse()) await stop().catch((e) => console.error(e));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
