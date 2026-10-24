// A time zone as it is saved (#1115): the spelling PostgreSQL knows, so the database's own zone checks (the weekly
// digest's scan reads pg_timezone_names exactly) find it. A case variant ("asia/ho_chi_minh") is saved as PostgreSQL
// spells it; a name it does not know is refused. pg_timezone_names reads the zone files on every query, so the names
// are read once per process and kept.
import { sql, type Transaction } from 'kysely';
import type { Database } from '@crove/db';
import { DomainError } from '@crove/kernel-runtime';

let names: Promise<ReadonlyMap<string, readonly string[]>> | null = null;

function zoneNames(trx: Transaction<Database>): Promise<ReadonlyMap<string, readonly string[]>> {
  names ??= sql<{ name: string }>`SELECT z.name FROM pg_catalog.pg_timezone_names z`.execute(trx).then(
    ({ rows }) => {
      const byLower = new Map<string, string[]>();
      for (const { name } of rows) byLower.set(name.toLowerCase(), [...(byLower.get(name.toLowerCase()) ?? []), name]);
      return byLower;
    },
    (error: unknown) => {
      names = null;
      throw error;
    },
  );
  return names;
}

export async function storedZone(trx: Transaction<Database>, zone: string): Promise<string> {
  const spellings = (await zoneNames(trx)).get(zone.toLowerCase()) ?? [];
  // The name as given when PostgreSQL has it so, else its own spelling.
  const name = spellings.includes(zone) ? zone : [...spellings].sort()[0];
  if (!name) throw new DomainError('VALIDATION', 422, 'Múi giờ không hợp lệ');
  return name;
}
