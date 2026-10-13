// Crove kernel entry point. One image, several roles:
//   migrate  apply SQL migrations, set role passwords, create the job schema
//   api      HTTP API + web UI
//   worker   outbox relay + jobs
//   all      api + worker in one process (default for self-host)
import { serve } from '@hono/node-server';
import { InvoiceExtractor } from '@crove/agent';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { LocalDiskStore, Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from './auth.ts';
import { loadConfig, type Config } from './config.ts';
import { createHttpApp } from './http.ts';
import { migrateJobs, startWorker } from './worker.ts';

type Role = 'migrate' | 'api' | 'worker' | 'all';

function buildRuntime(config: Config, connectionString: string, applicationName: string) {
  const pool = createPool({ connectionString, applicationName, max: 10 });
  const db = createDb(pool);
  const runtime = new Runtime(db).register({
    commands: [...kernelCommands, ...financeCommands],
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

async function main() {
  const role = (process.argv[2] ?? 'all') as Role;
  if (!['migrate', 'api', 'worker', 'all'].includes(role)) throw new Error(`unknown role ${role}`);
  const config = loadConfig();
  if (role === 'migrate') return runMigrate(config);

  const store = new LocalDiskStore(config.STORAGE_DIR);
  const stops: Array<() => Promise<void>> = [];

  if (role === 'api' || role === 'all') {
    const { pool, db, runtime } = buildRuntime(config, config.DATABASE_URL, 'crove-api');
    const authenticate = createAuthenticator(config, db);
    const app = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: buildExtractor(config) !== null });
    const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' });
    console.log(`[api] listening on :${config.PORT}`);
    stops.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    });
  }

  if (role === 'worker' || role === 'all') {
    const connectionString = config.WORKER_DATABASE_URL ?? config.DATABASE_URL;
    const { pool, db, runtime } = buildRuntime(config, connectionString, 'crove-worker');
    const stop = await startWorker({ connectionString, workerDb: db, runtime, store, extractor: buildExtractor(config) });
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
