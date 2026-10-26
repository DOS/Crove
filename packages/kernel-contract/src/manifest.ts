// A module's manifest (plan §5.2, #1588, #1599): the module and the database tables it owns, per schema, with every
// column of each table and its data class. A database test (apps/kernel/test/manifest.db.test.ts) checks the manifests
// against the catalog after the migrations: every table of a crove_* schema belongs to exactly one manifest, every
// column of it is classified, and every table and column a manifest names exists. Entities, permissions and routes
// join the manifest later (§5.2).

// What a column holds (plan §5.2, §4.7, §4.10):
// - internal: business data that is not about a person (amounts, dates, ids, statuses, codes, the org's own texts).
// - pii: identifies or describes a person: a name, an IP address, free text a person wrote about themselves, or a
//   document or payload that carries such data (an extracted invoice, a mail's merge data).
// - contact: a person's contact detail (email, phone, postal address); writing one is policy P04.
// - payment: a bank account or card number; writing one is policy P04.
// - national_id: a person's national id (CCCD) or personal tax code.
// - national_id_if_individual: a tax code that is a person's national id when its holder is an individual (a party, a
//   legal entity that may be a household business).
// - sensitive: a secret (a sealed credential, a bearer token, a signing key) or sensitive personal data (Decree
//   356/2025); never copied into search, logs, exports or prompts.
export const DATA_CLASSES = ['internal', 'pii', 'contact', 'payment', 'national_id', 'national_id_if_individual', 'sensitive'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

// Every column of one table with its class.
export type TableColumns = Readonly<Record<string, DataClass>>;

// A table's columns: the listed ones are `internal`, and `classified` gives every other column its class. A column in
// both is a mistake in the manifest, refused when the module loads.
export function columns(internal: readonly string[], classified: Readonly<Record<string, Exclude<DataClass, 'internal'>>> = {}): TableColumns {
  const out: Record<string, DataClass> = {};
  for (const c of internal) out[c] = 'internal';
  for (const [c, cls] of Object.entries(classified)) {
    if (c in out) throw new Error(`manifest: column ${c} is listed as internal and as ${cls}`);
    out[c] = cls;
  }
  return Object.freeze(out);
}

export interface ModuleManifest {
  readonly id: string;
  // Schema name -> table name (sorted) -> every column of the table with its class.
  readonly tables: Readonly<Record<string, Readonly<Record<string, TableColumns>>>>;
}

// `const` keeps each manifest's lists readonly, so an importer cannot change who owns a table.
export const defineModule = <const M extends ModuleManifest>(manifest: M): M => manifest;
