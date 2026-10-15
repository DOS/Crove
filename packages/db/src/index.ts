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

// Session state a checkout may leave on its connection, cleared before the connection goes back to the pool
// (#117). A session-level set_config('crove.ctx' | 'crove.ctx_seal' | 'crove.org_id' | 'crove.user_id', ..., false)
// survives COMMIT and makes every later enter_context on that backend raise CONTEXT_REENTRY and every helper raise
// CONTEXT_SEAL_INVALID; a session-level pg_advisory_lock on the context key, a SET ROLE or a changed search_path
// or default_transaction_read_only do the same kind of harm. One simple-protocol round trip resets all of it:
// - RESET ALL: every setting back to its session default, which keeps the startup values pg sends
//   (application_name, statement_timeout, idle_in_transaction_session_timeout). It does not reset the role.
// - RESET ROLE: back to the login role (no Crove login role can change session_authorization).
// - pg_advisory_unlock_all(): session-level advisory locks (transaction-level ones end with the transaction).
// - CLOSE ALL and UNLISTEN *: held cursors and LISTEN registrations, which would otherwise outlive the checkout.
// Not DISCARD ALL: it also runs DEALLOCATE ALL, which breaks pg's client-side cache of named prepared statements
// on that connection, and DISCARD PLANS, which throws away the backend's cached PL/pgSQL plans; TEMP needs no
// reset because no Crove role may create temporary objects (T17). Cost: one round trip per checkout, after
// release, so the caller does not wait for it; the connection stays out of the pool for that round trip
// (apps/kernel/test/context-cost.db.test.ts measures it).
// Behind a transaction-mode pooler (PgBouncer, Supavisor; plan §3.3) this reset reaches whichever server backend
// the pooler picks for it, not necessarily the one the checkout used, so it protects direct connections only; the
// pooler's own reset decides there (PgBouncer runs server_reset_query only in session mode unless
// server_reset_query_always is set).
export const SESSION_RESET_SQL =
  'CLOSE ALL; RESET ALL; RESET ROLE; UNLISTEN *; SELECT pg_catalog.pg_advisory_unlock_all()';

type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: Error | boolean) => void) => void;

// Wraps release() of a checked-out client: the client returns to the pool only after SESSION_RESET_SQL has run on
// it, so the next checkout can never see this one's session state. The caller does not wait for the reset. A
// client released with an error, inside a transaction (status other than idle) or whose reset fails is destroyed
// instead of pooled: RESET inside an open transaction would be undone by its ROLLBACK.
function resetOnRelease(client: pg.PoolClient): pg.PoolClient {
  const release = client.release.bind(client);
  let released = false;
  client.release = (err?: Error | boolean) => {
    if (released) throw new Error('Release called on client which has already been released to the pool.');
    released = true;
    if (err) return release(err);
    if (client.getTransactionStatus() !== 'I') return release(new Error('client released inside a transaction'));
    // While the reset runs nobody holds the client, so a lost connection must not reach the process as an unhandled
    // 'error' event; the reset query fails with the same error, and that destroys the client.
    const ignore = () => {};
    client.on('error', ignore);
    client.query(SESSION_RESET_SQL).then(
      () => {
        client.removeListener('error', ignore);
        release();
      },
      (error: unknown) => {
        client.removeListener('error', ignore);
        release(error instanceof Error ? error : new Error(String(error)));
      },
    ).catch((error: unknown) => console.error('[db] release after session reset failed', (error as Error)?.message));
  };
  return client;
}

// pg.Pool whose every checkout, including pool.query(), resets its session on release.
class SessionResetPool extends pg.Pool {
  connect(): Promise<pg.PoolClient>;
  connect(callback: ConnectCallback): void;
  connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    if (!callback) return super.connect().then(resetOnRelease);
    super.connect((err, client, done) => {
      if (err || !client) return callback(err, client, done);
      resetOnRelease(client);
      callback(undefined, client, client.release);
    });
  }
}

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new SessionResetPool({
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
