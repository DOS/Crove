// A module's manifest (plan §5.2, first step, #1588): the module and the database tables it owns, per schema. A
// database test (apps/kernel/test/manifest.db.test.ts) checks the manifests against the catalog after the migrations:
// every table of a crove_* schema belongs to exactly one manifest, and every table a manifest names exists. Entities,
// per-column classification, permissions and routes join the manifest later (§5.2).
export interface ModuleManifest {
  id: string;
  // Schema name -> the tables of that schema the module owns, sorted.
  tables: Readonly<Record<string, readonly string[]>>;
}

export const defineModule = <M extends ModuleManifest>(manifest: M): M => manifest;
