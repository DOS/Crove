// Connection settings for the throwaway spike database (see README.md). Nothing here is a real secret: the
// container is local, bound to 127.0.0.1 and deleted after the run.
const host = process.env.SPIKE_PG_HOST ?? '127.0.0.1';
const port = process.env.SPIKE_PG_PORT ?? '55959';
const adminPassword = process.env.SPIKE_PG_PASSWORD ?? 'spike';

export const DB_NAME = 'spike';
// The DBOS system schema. Named like a Crove schema to show DBOS runs under a custom schema name.
export const SCHEMA = 'crove_dbos';
export const APP_NAME = 'crove-spike';
// Pinned on purpose: the default application version is a hash of the workflow code, and an executor only
// recovers or dequeues workflows of its own version (see the ADR, "Deploys").
export const APP_VERSION = process.env.SPIKE_APP_VERSION ?? 'spike-v1';

const url = (user: string, password: string, db: string) => `postgres://${user}:${password}@${host}:${port}/${db}`;
/** A URL for one of the spike roles on another database (the schema experiment uses its own databases). */
export const dbUrl = (user: 'postgres' | 'spike_migrate' | 'spike_runner', db: string) => url(user, user === 'postgres' ? adminPassword : 'spike', db);

// Superuser: only creates the database and the roles, and observes pg_stat_activity.
export const adminUrl = url('postgres', adminPassword, 'postgres');
export const observerUrl = url('postgres', adminPassword, DB_NAME);
// Owns the DBOS schema and applies the committed SQL (plays Crove's `migrate` role). Not a superuser.
export const migrateUrl = url('spike_migrate', 'spike', DB_NAME);
// Runs workflows (plays `crove_worker` / `crove_queue`). DML only, no DDL anywhere.
export const runnerUrl = url('spike_runner', 'spike', DB_NAME);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
