// Crove kernel entry point. One image, several roles:
//   migrate      apply SQL migrations, set role passwords, create the job schema
//   auth-grants  after Supabase Auth has started: let the session check read auth.sessions, auth.users and
//                auth.mfa_factors (user_id, status)
//   api          HTTP API + web UI
//   worker   outbox relay + jobs
//   all      api + worker in one process (default for self-host)
//   prober   health check and alert (plan §4.13): once, or `--every <seconds>`; `--test-alert` sends a test alert
// It wires the open-source default adapters into the composition root (createKernel, ADR-0030).
import { applyAuthGrants, migrate, setRolePasswords } from '@crove/db/migrate';
import { liveAuthUrl, loadConfig, type Config } from './config.ts';
import { createKernel, defaultAdapters, type ServerRole } from './kernel.ts';
import { describeMailer } from './mail.ts';
import { runProber } from './prober.ts';
import { describeStorage } from './storage.ts';
import { migrateJobs } from './worker.ts';

type Role = 'migrate' | 'auth-grants' | 'prober' | ServerRole;
const ROLES: readonly Role[] = ['migrate', 'auth-grants', 'api', 'worker', 'all', 'prober'];

async function runMigrate(config: Config) {
  const adminUrl = config.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is required for migrate');
  const applied = await migrate({ adminUrl, dir: config.MIGRATIONS_DIR, log: (m) => console.log(`[migrate] ${m}`) });
  await setRolePasswords(adminUrl, {
    crove_app: config.CROVE_APP_DB_PASSWORD,
    crove_worker: config.CROVE_WORKER_DB_PASSWORD,
    crove_prober: config.CROVE_PROBER_DB_PASSWORD,
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
  // The prober needs only its own settings (no auth, storage or AI configuration), so it reads them itself.
  if (role === 'prober') process.exit(await runProber(process.argv.slice(3)));
  const config = loadConfig();
  if (role === 'migrate') return runMigrate(config);
  if (role === 'auth-grants') return runAuthGrants(config);
  const live = config.AUTH_SESSION_CHECK === 'jwt' ? liveAuthUrl(config) : null;
  console.log(
    `[auth] session check: ${config.AUTH_SESSION_CHECK}, step-up for R3: ${config.AUTH_STEP_UP}` +
      (config.AUTH_SESSION_CHECK === 'jwt' ? `, live check for R3: ${live ? new URL(live).host : 'not configured (R3 answers 503)'}` : ''),
  );
  console.log(`[storage] ${describeStorage(config)}`);
  console.log(`[mail] ${describeMailer(config)}`);

  const kernel = createKernel(config, defaultAdapters(config));
  const stop = await kernel.start(role);

  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
