import type { Kysely } from 'kysely';
import type { Database } from './schema.ts';

// Cell-ready connection resolution (plan Decision 14, §3.6). A cell is one database holding the tenant data of
// some orgs; the control plane holds identity, the tenant directory, staff and sessions. Every tenant
// transaction opens on the database that resolveTenant() returns for its org; org-less work opens on
// controlPlane(). Today there is one database (singleCell), so both return the same Db and nothing changes; a
// later multi-cell resolver looks the org up in the tenant directory without touching the callers.
export interface CellResolver {
  // The database holding this org's tenant data. Async so a later resolver can read the tenant directory. It runs
  // before any session or membership check, so an unknown org must resolve to some cell (where enter_context
  // refuses it as for a non-member) and never raise a different error that reveals which org ids exist.
  resolveTenant(orgId: string): Promise<Kysely<Database>>;
  // The control-plane database, for work that has no org yet (signed-in user reads, org creation, inbound mail).
  controlPlane(): Kysely<Database>;
}

// One database for the control plane and every org.
export function singleCell(db: Kysely<Database>): CellResolver {
  return {
    resolveTenant: async () => db,
    controlPlane: () => db,
  };
}
