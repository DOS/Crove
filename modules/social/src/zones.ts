// A time zone as it is saved (#1115): the spelling PostgreSQL knows, so the database's own zone checks (the weekly
// digest's scan reads pg_timezone_names exactly) find it. A case variant ("asia/ho_chi_minh") is saved as PostgreSQL
// spells it; a name it does not know is refused.
import { sql, type Transaction } from 'kysely';
import type { Database } from '@crove/db';
import { DomainError } from '@crove/kernel-runtime';

export async function storedZone(trx: Transaction<Database>, zone: string): Promise<string> {
  const { rows } = await sql<{ name: string }>`
    SELECT z.name FROM pg_catalog.pg_timezone_names z
    WHERE pg_catalog.lower(z.name) = pg_catalog.lower(${zone}::text)
    ORDER BY z.name = ${zone}::text DESC, z.name
    LIMIT 1`.execute(trx);
  const name = rows[0]?.name;
  if (!name) throw new DomainError('VALIDATION', 422, 'Múi giờ không hợp lệ');
  return name;
}
