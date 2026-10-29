// A module's manifest (plan §5.2, #1588, #1599, #1630, #1652, #1656, #1651): the module, the modules it imports, the
// database tables it owns, per schema, with every column of each table and its data class, the permissions it owns, its screens in the app with
// their menu items, and its entities. A database test (apps/kernel/test/manifest.db.test.ts) checks the manifests
// against the catalog after the migrations: every table of a crove_* schema belongs to exactly one manifest, every
// column of it is classified, every table and column a manifest names exists, every permission a role grants or
// something checks is declared, with the roles that grant it, and every entity matches its table and numbering series.
// apps/app/test/module-screens.test.ts checks the screens against the app's router, and `pnpm depcruise`
// (.dependency-cruiser.mjs) checks every import against `dependsOn`.
import type { BuiltinRoleKey } from './roles.ts';

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
// both is a mistake in the manifest, refused when the module loads. The result keeps the column names in its type, so
// auditValue() refuses a column the table does not have at typecheck.
export function columns<const I extends string, const C extends string = never>(
  internal: readonly I[],
  classified: Readonly<Record<C, Exclude<DataClass, 'internal'>>> = {} as Record<C, Exclude<DataClass, 'internal'>>,
): Readonly<Record<I | C, DataClass>> {
  const out: Record<string, DataClass> = {};
  for (const c of internal) out[c] = 'internal';
  for (const [c, cls] of Object.entries(classified) as Array<[string, DataClass]>) {
    if (Object.hasOwn(out, c)) throw new Error(`manifest: column ${c} is listed as internal and as ${cls}`);
    out[c] = cls;
  }
  return Object.freeze(out) as Readonly<Record<I | C, DataClass>>;
}

// What a command writes in one table (plan §4.7 "Derived risk", #1697): the table as `<schema>.<table>`, the class of
// every column of it as its manifest gives them, and the columns the command's statements set. A command declares one
// per table it writes (CommandDef.writes); the runtime checks each column against the classes when the command
// registers, and an agent's proposal of a command that writes a `contact` or `payment` column is flagged P04.
export interface TableWrite {
  readonly table: string;
  readonly classes: TableColumns;
  readonly columns: readonly string[];
}

// A TableWrite built from a module's manifest, so the classes are the manifest's and a column the table does not have
// fails typecheck: tableWrite(kernelManifest.tables, 'crove_kernel', 'task', ['status']).
export function tableWrite<
  const T extends ModuleManifest['tables'],
  const S extends keyof T & string,
  const N extends keyof T[S] & string,
>(tables: T, schema: S, table: N, columns: readonly (keyof T[S][N] & string)[]): TableWrite {
  const classes = tables[schema]?.[table] as TableColumns | undefined;
  if (!classes) throw new Error(`tableWrite: the manifest has no table ${schema}.${table}`);
  return Object.freeze({ table: `${schema}.${table}`, classes, columns: Object.freeze([...columns]) });
}

// What an audit fact keeps of a classified column's value (plan §4.10, #1626): the class, never the value. Audit rows
// are append-only and anchored in the WORM stream, so personal data the PDPL erasure (#923) must reach can never be
// written there; the row's input_sha256 still ties it to the command's input.
export interface RedactedValue {
  readonly redacted: Exclude<DataClass, 'internal'>;
}

// A column's value as an audit fact (ctx.audit, or the audit facts of a DomainError): an internal value as it is, a
// value of any other class replaced by a marker naming the class, and an absent value (null or undefined) kept, since
// "there was none" or "it was cleared" says nothing about a person. Every fact whose key names a classified column, or
// that holds a classified column's value, goes through this; apps/kernel/test/audit-facts.test.ts fails on one that
// does not. A column the table does not have throws, so a misspelt column never passes a value through.
export function auditValue<T extends TableColumns, V>(table: T, column: keyof T & string, value: V): V | RedactedValue {
  if (!Object.hasOwn(table, column)) throw new Error(`auditValue: the table has no column ${column}`);
  const cls = table[column] as DataClass;
  if (cls === 'internal' || value === null || value === undefined) return value;
  return Object.freeze({ redacted: cls });
}

// A permission the module owns (plan §5.2, §4.6, #1630). Its key is `<module id>.<name>`. A member holds it through an
// org-wide assignment of one of its default roles, which are the crove_kernel.role_permission rows the migrations seed
// for it (a declaration, not a grant: the test fails when the two differ). The base roles of tenant_member.role (owner,
// admin) are never listed: who passes a command by base role is the command's `access`, and who approves by base role
// is the approval policy. The risk is the highest risk of the commands that name the permission.
export interface PermissionDeclaration {
  readonly key: string;
  readonly risk: 'R0' | 'R1' | 'R2' | 'R3';
  readonly defaultRoles: readonly BuiltinRoleKey[];
}

// A screen of the app under /o/$slug (plan §5.2 `routes`, ADR-0031 §3, #1652). A deployment without the module sends
// the screen to the inbox, and every /o/$slug route of the app's router belongs to exactly one manifest.
export interface RouteDeclaration {
  // The path under /o/$slug, as the router writes it: 'journal', 'inbox/$id', 'social/new'.
  readonly path: string;
  // A permission the screen needs beyond membership, declared by some manifest. Absent when the queries the screen
  // loads decide who sees it, which the server checks on every query and command; no screen names one yet.
  readonly permission?: string;
  // The app of a screen no menu item names, reached from inside that app (the guide), so a deep link opens with it.
  readonly app?: string;
}

// A menu item of the app's shell (plan §5.2 `nav`, DESIGN.md §9, #1652): one of the module's routes, in a group of an
// app's menu or, with `app: null`, among the org's own screens at the foot of the app switcher. The label is a key
// under `nav` in the app's messages, in Vietnamese and English; apps are listed, and their groups ordered, in the order
// their items first appear.
export type NavDeclaration =
  | { readonly app: string; readonly group: string; readonly path: string; readonly label: string }
  | { readonly app: null; readonly path: string; readonly label: string };

// A screen of the app outside /o/$slug (#1660): a share target, an OAuth callback, a link sent outside the org. A
// deployment without the module answers it not found, as the API answers its calls, and every route of the app's
// router outside /o/$slug belongs to exactly one manifest.
export interface OutsideRouteDeclaration {
  // The full path, as the router writes it: '/-/share', '/-/b/$org/$type'.
  readonly path: string;
  // Opened without an account (a client's or a visitor's link): the module guard adds no sign-in.
  readonly public?: true;
}

// A module's screens and menu items. They are data with no server code, so the app's bundle reads them from
// @crove/kernel-contract (MODULE_SCREENS in screens.ts) and each module's manifest names its own entry there.
export interface ModuleScreens {
  readonly routes: readonly RouteDeclaration[];
  // Its screens outside /o/$slug, when it has any.
  readonly outside?: readonly OutsideRouteDeclaration[];
  readonly nav: readonly NavDeclaration[];
}

// How an entity's changes are recorded (plan §5.2 `audit`, #1656):
// - command: every change is a command, recorded in audit_event (and the WORM stream) with the record as its target;
//   the row itself may be updated.
// - append_only: as command, and the row is never updated or deleted (the table carries crove_kernel.make_append_only's
//   trigger), so the table is its own history: a correction is a new row, such as a reversal or a void.
export type EntityAudit = 'command' | 'append_only';

// A record type the module owns (plan §5.2 `entities`, #1656): the type audit events, number allocations and activity
// name its records by, and the table of the module's own schema (crove_<module id>) that holds them. The record,
// timeline, files and sharing features of the plan's entity are not built yet, so those fields are not declared.
export interface EntityDeclaration {
  // `<module id>.<entity>`, as commands name it in their audit target.
  readonly type: string;
  readonly table: string;
  // The table has a legal_entity_id column: a record belongs to, or names, one legal entity of the org (§4.6). A list
  // of entities (member_invite.legal_entity_ids) does not make it scoped.
  readonly legalEntityScoped: boolean;
  // Records numbered by the kernel's gapless numbering (#1401): the doc type of their series, one per legal entity. A
  // doc type that ends in `<column>` takes the row's value of that column (finance.cash_voucher.<voucher_type> numbers
  // PT, PC, BC and BN apart). The reset period is the org's policy (number_series_policy), not the manifest's.
  readonly numbering?: { readonly docType: string };
  readonly audit: EntityAudit;
}

export interface ModuleManifest extends ModuleScreens {
  readonly id: string;
  // The modules this one imports, by id (plan §5.1, §5.2 `dependsOn`): sorted, and a DAG. dependency-cruiser's rules
  // are generated from it (tools/depcruise-rules.mjs), which refuses an unsorted list or a cycle, so an import of a
  // module not listed here fails `pnpm depcruise`.
  readonly dependsOn: readonly string[];
  // Schema name -> table name (sorted) -> every column of the table with its class.
  readonly tables: Readonly<Record<string, Readonly<Record<string, TableColumns>>>>;
  // The permissions the module owns, sorted by key; empty when it owns none.
  readonly permissions: readonly PermissionDeclaration[];
  // The record types the module owns, sorted by type; empty when it owns none.
  readonly entities: readonly EntityDeclaration[];
}

// `const` keeps each manifest's lists readonly at typecheck, and the manifest is deep-frozen when it is defined, so no
// code that imports it (another module at import time, a command) can change who owns a table or swap a table's column
// classes before the runtime reads them (P04 rests on them, #1710).
export const defineModule = <const M extends ModuleManifest>(manifest: M): M => deepFreeze(manifest);

// Freezes the value and everything it holds, already frozen parts included (a shallow freeze leaves their children).
// A manifest is plain data: an accessor property (a getter or setter) is refused, since freezing keeps it and it could
// answer one class while it is checked and another later (#1766).
function deepFreeze<T>(value: T, path = 'manifest', seen = new WeakSet<object>()): T {
  if (typeof value === 'object' && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property && !('value' in property)) throw new Error(`${path}.${String(key)}: a manifest holds plain data, not a getter or setter`);
    }
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`, seen);
  }
  return value;
}
