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
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'crove',
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 10_000,
    types,
  });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export type Db = Kysely<Database>;
