import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { Database } from './schema.ts';

export type { Database } from './schema.ts';
export * from './schema.ts';

// Money (numeric), int8 and dates stay strings end to end; timestamptz becomes a Date.
const NUMERIC = 1700;
const INT8 = 20;
const DATE = 1082;
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === NUMERIC || oid === INT8 || oid === DATE) return (value: string) => value;
    return pg.types.getTypeParser(oid, format);
  }) as pg.CustomTypesConfig['getTypeParser'],
};

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
}

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'crove',
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 10_000,
    types,
  });
  // An idle client losing its connection (database restart) emits 'error'; unhandled, it would exit the process.
  pool.on('error', (error) => console.error('[db] idle client error', error.message));
  return pool;
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export type Db = Kysely<Database>;

// Row-level security is the tenant boundary, so the API and worker must never connect as a role that skips it.
export async function assertRlsEnforced(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const role = rows[0];
  const owned = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'crove\\_%' AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)",
  );
  if (!role || role.rolsuper || role.rolbypassrls || Number(owned.rows[0]?.n ?? 0) > 0) {
    throw new Error(`database role ${role?.rolname ?? '?'} bypasses row-level security; connect as crove_app / crove_worker`);
  }
}

// System work belongs to the worker alone (External-tenant gate T5): the API role must not be able to enter
// system context, resolve inbound tokens or claim inbound mail, and the worker role must. Functions that do
// not exist yet (before migrate) are skipped.
export const WORKER_ONLY_FUNCTIONS = [
  'crove_kernel.enter_system_context(uuid)',
  'crove_kernel.org_by_inbound_token(text)',
  'crove_kernel.inbound_claim(integer)',
] as const;

export async function assertSystemContextAccess(pool: pg.Pool, expected: 'denied' | 'granted'): Promise<void> {
  const { rows } = await pool.query<{ rolname: string; fn: string; can: boolean }>(
    `SELECT current_user AS rolname, f.name AS fn, has_function_privilege(f.oid, 'EXECUTE') AS can
     FROM (SELECT name, to_regprocedure(name)::oid AS oid FROM unnest($1::text[]) name) f
     WHERE f.oid IS NOT NULL`,
    [WORKER_ONLY_FUNCTIONS],
  );
  const wrong = rows.filter((row) => row.can !== (expected === 'granted'));
  if (wrong.length === 0) return;
  const role = wrong[0]?.rolname ?? '?';
  const names = wrong.map((row) => row.fn).join(', ');
  if (expected === 'denied') {
    throw new Error(`database role ${role} can enter system context (${names}); the API must connect as crove_app (run migrate first)`);
  }
  throw new Error(`database role ${role} cannot enter system context (${names}); the worker must connect as crove_worker (WORKER_DATABASE_URL)`);
}
