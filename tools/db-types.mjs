// Generates the Kysely table types in packages/db/src/generated/database.ts from the database the committed
// migrations build (plan §2 DB row, issue #48). Run `pnpm db:types` after adding or changing a migration and commit
// the result; CI runs it too and fails when the committed file is not current.
//
// Needs CROVE_TEST_ADMIN_URL (a superuser URL on PostgreSQL 17, as for `pnpm test:db`). The run creates a throwaway
// database, applies supabase/migrations with the built-in runner, reads it with Kanel and kanel-kysely, and drops it.
//
// What is generated, and how it differs from Kanel's defaults:
// - Only the tables the tenant role (crove_tenant) may SELECT. Control-plane tables (plan §3.6: user_account, sessions,
//   inbound routing and the like) and definer-only tables have no Kysely type, so tenant code cannot name them in a
//   query that compiles. The invariant test control-plane-reads.test.ts also scans this generated file.
// - Plain column types instead of Kanel's branded identifier types; json/jsonb columns take JSON text on insert and
//   update (code passes JSON.stringify output, never an object or array, to pg).
// - Write types from the tenant role's privileges (issue #266): a column crove_tenant may not INSERT has the insert
//   type NotGranted, one it may not UPDATE the update type NotGranted (has_column_privilege, which counts table and
//   column grants alike). NotGranted is undefined, not never: Kysely drops a never column from Insertable and
//   Updateable, and a table with no writable column would then take any object, while undefined keeps the column
//   and refuses every value. So a forbidden write, such as an insert into outbox_event or an update of an
//   append-only table, fails typecheck instead of at runtime (Kysely leaves an undefined value out of the statement).
//   The login roles (crove_app, crove_worker) are members of crove_tenant with no table privilege of their own on
//   these schemas. This covers values() and set() with a value; DELETE (not a column type), raw sql, insert ...
//   select and an empty object are refused only by the database at runtime.
// - One file, named exports, sorted, LF line endings, so the output depends only on the migrations.
// packages/db/src/schema.ts refines these types (CHECK-constraint unions, columns only triggers or definers write)
// and is what code imports.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePgTsGenerator, processDatabase, useKanelContext } from 'kanel';
import { makeKyselyHook } from 'kanel-kysely';
import pg from 'pg';
import { migrate } from '../packages/db/src/migrate.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const OUTPUT = 'packages/db/src/generated/database.ts';

// Schemas whose tables the kernel and modules query through Kysely. crove_meta (the migration ledger) is read with
// raw SQL only; crove_jobs belongs to pg-boss.
const SCHEMAS = ['crove_kernel', 'crove_finance', 'crove_social', 'crove_crm', 'crove_notes'];
// The role tenant code runs as (packages/db/src/context); a table it cannot SELECT gets no type.
const TENANT_ROLE = 'crove_tenant';
// The write type of a column TENANT_ROLE may not write; exported so schema.ts keeps it through a refinement.
const NOT_GRANTED = 'NotGranted';
const notGranted = {
  declarationType: 'typeDeclaration',
  name: NOT_GRANTED,
  comment: [
    `The insert or update type of a column ${TENANT_ROLE} may not insert or update: no value but undefined, which`,
    'Kysely leaves out of the statement, so a write of the column fails typecheck.',
  ],
  typeDefinition: ['undefined'],
  exportAs: 'named',
};

// Every column type in the Crove schemas, as the pool's type parsers return it (packages/db/src/index.ts): numeric,
// int8 and date stay strings, timestamptz is a Date, json and jsonb are parsed. A type missing here fails the run.
const TYPE_MAP = {
  'pg_catalog.bool': 'boolean',
  'pg_catalog.bytea': 'Buffer',
  'pg_catalog.date': 'string',
  // real (#1180): pg parses float4 to a JavaScript number.
  'pg_catalog.float4': 'number',
  'pg_catalog.int2': 'number',
  'pg_catalog.int4': 'number',
  'pg_catalog.int8': 'string',
  'pg_catalog.json': 'unknown',
  'pg_catalog.jsonb': 'unknown',
  'pg_catalog.numeric': 'string',
  'pg_catalog.text': 'string',
  'pg_catalog.timestamptz': 'Date',
  // The search columns (#673): pg returns a tsvector as its text form.
  'pg_catalog.tsvector': 'string',
  'pg_catalog.uuid': 'string',
  'pg_catalog.xid8': 'string',
};

const pascal = (name) => name.replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
// crove_kernel.tenant -> KernelTenantTable: unique across schemas, which may reuse a table name.
const tableInterface = (schema, table) => `${pascal(schema.replace(/^crove_/, ''))}${pascal(table)}Table`;
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// The column's base type from the type map (through a domain to its base type), ignoring Kanel's identifier types
// and foreign key resolution.
function baseType(column) {
  let name = column.type.fullName;
  if (column.type.kind === 'domain') {
    const [schema, domain] = name.split('.');
    const details = useKanelContext().schemas[schema]?.domains.find((d) => d.name === domain);
    if (!details) throw new Error(`db-types: domain ${name} not found`);
    name = details.innerType;
  }
  const type = TYPE_MAP[name];
  if (typeof type !== 'string') throw new Error(`db-types: no TypeScript type for ${name} (add it to TYPE_MAP in tools/db-types.mjs)`);
  return type;
}

// json/jsonb: unknown (null included) when selected, JSON text when inserted or updated.
function jsonColumnType(column) {
  const write = column.isNullable ? 'string | null' : 'string';
  const insert = column.isNullable || column.defaultValue != null ? `${write} | undefined` : write;
  return `ColumnType<unknown, ${insert}, ${write}>`;
}

// [select, insert, update] of a property type in the forms kanel-kysely and jsonColumnType write: T, Generated<T> or
// ColumnType<S, I, U>.
function columnParts(typeName) {
  const generated = /^Generated<([^<>]*)>$/.exec(typeName)?.[1];
  if (generated) return [generated, `${generated} | undefined`, generated];
  const parts = /^ColumnType<([^<>]*)>$/.exec(typeName)?.[1]?.split(', ');
  if (parts?.length === 3) return parts;
  if (typeName.includes('<')) throw new Error(`db-types: unexpected column type ${typeName}`);
  return [typeName, typeName, typeName];
}

// Kysely's short forms: ColumnType<T, T, T> is T, ColumnType<T, T | undefined, T> is Generated<T>.
function columnType([select, insert, update]) {
  if (insert === select && update === select) return select;
  if (insert === `${select} | undefined` && update === select) return `Generated<${select}>`;
  return `ColumnType<${select}, ${insert}, ${update}>`;
}

// The last pre-render hook: everything in one file with named exports, sorted by name, without the
// Selectable/Insertable/Updateable aliases and identifier types (code derives those from Database if it needs them).
function singleFile(outputPath, writable) {
  return (output) => {
    const { schemas } = useKanelContext();
    const tables = new Map();
    for (const schema of Object.values(schemas)) {
      for (const table of schema.tables) tables.set(tableInterface(table.schemaName, table.name), table);
    }
    // Imports between the files Kanel would have written; everything is in one file now.
    const typeImports = (declaration) => (declaration.typeImports ?? []).filter((i) => i.isAbsolute);
    const interfaces = [];
    const schemaInterfaces = [];
    let database;
    for (const file of Object.values(output)) {
      if (file.fileType !== 'typescript') throw new Error('db-types: unexpected non-TypeScript output');
      for (const declaration of file.declarations) {
        if (declaration.declarationType === 'interface' && tables.has(declaration.name)) {
          const table = tables.get(declaration.name);
          const properties = declaration.properties.map((property) => {
            const column = table.columns.find((c) => c.name === property.name);
            if (!column) throw new Error(`db-types: no column ${property.name} in ${table.schemaName}.${table.name}`);
            const json = column.type.fullName === 'pg_catalog.json' || column.type.fullName === 'pg_catalog.jsonb';
            const [select, insert, update] = columnParts(json ? jsonColumnType(column) : property.typeName);
            const key = `${table.schemaName}.${table.name}.${column.name}`;
            const typeName = columnType([
              select,
              writable.insert.has(key) ? insert : NOT_GRANTED,
              writable.update.has(key) ? update : NOT_GRANTED,
            ]);
            return { ...property, comment: undefined, typeName };
          });
          const kysely = ['ColumnType', 'Generated'].filter((name) => properties.some((p) => p.typeName.startsWith(`${name}<`)));
          interfaces.push({
            ...declaration,
            comment: [`${table.schemaName}.${table.name}`],
            properties,
            typeImports: kysely.map((name) => ({ name, isDefault: false, path: 'kysely', isAbsolute: true, importAsType: true })),
            exportAs: 'named',
          });
        } else if (declaration.declarationType === 'interface' && /^Crove[A-Za-z]+Schema$/.test(declaration.name)) {
          schemaInterfaces.push({
            ...declaration,
            properties: [...declaration.properties].sort(byName),
            typeImports: typeImports(declaration),
            exportAs: 'named',
          });
        } else if (declaration.declarationType === 'typeDeclaration' && declaration.name === 'Database') {
          database = {
            ...declaration,
            // kanel-kysely joins the schema types in the order the catalog lists the schemas, which changes from one
            // database to the next: sorted, so the file depends only on the migrations.
            typeDefinition: declaration.typeDefinition.map((line) => line.split(' & ').sort().join(' & ')),
            comment: [`Every table of ${SCHEMAS.join(', ')} that ${TENANT_ROLE} may read.`],
            typeImports: typeImports(declaration),
            exportAs: 'named',
          };
        }
      }
    }
    if (!database) throw new Error('db-types: kanel-kysely produced no Database type');
    if (interfaces.length !== tables.size) throw new Error('db-types: a table produced no interface');
    return {
      [outputPath]: {
        fileType: 'typescript',
        declarations: [database, notGranted, ...schemaInterfaces.sort(byName), ...interfaces.sort(byName)],
      },
    };
  };
}

// LF endings, no blank line between the members of an interface, one trailing newline.
function render(text) {
  const lines = text.replaceAll('\r\n', '\n').trimEnd().split('\n');
  const body = lines.filter((line, i) => !(line === '' && lines[i - 1]?.endsWith(';') && lines[i + 1]?.startsWith('  ')));
  return [
    '// @generated by tools/db-types.mjs (`pnpm db:types`) from the database that supabase/migrations builds. Do not',
    '// edit: change a migration and run the script again. Code imports the refined types from ../schema.ts.',
    '',
    ...body,
    '',
  ].join('\n');
}

// The tables crove_tenant may SELECT, and the columns of those tables it may INSERT and UPDATE, as
// schema.table and schema.table.column.
async function tenantPrivileges(dbUrl) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      `SELECT n.nspname AS schema, c.relname AS name FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1) AND pg_catalog.has_table_privilege($2, c.oid, 'SELECT')`,
      [SCHEMAS, TENANT_ROLE],
    );
    const { rows: columns } = await client.query(
      `SELECT n.nspname AS schema, c.relname AS name, a.attname AS column,
              pg_catalog.has_column_privilege($2, c.oid, a.attnum, 'INSERT') AS insert,
              pg_catalog.has_column_privilege($2, c.oid, a.attnum, 'UPDATE') AS update
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1) AND pg_catalog.has_table_privilege($2, c.oid, 'SELECT')`,
      [SCHEMAS, TENANT_ROLE],
    );
    const key = (r) => `${r.schema}.${r.name}.${r.column}`;
    return {
      readable: new Set(tables.map((r) => `${r.schema}.${r.name}`)),
      insert: new Set(columns.filter((r) => r.insert).map(key)),
      update: new Set(columns.filter((r) => r.update).map(key)),
    };
  } finally {
    await client.end();
  }
}

async function main() {
  const adminUrl = process.env.CROVE_TEST_ADMIN_URL;
  if (!adminUrl) throw new Error('db-types: set CROVE_TEST_ADMIN_URL to a superuser URL on PostgreSQL 17');
  const dbName = `crove_types_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const dbUrl = url.toString();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const warn = console.warn;
  const info = console.info;
  let work;
  let created = false;
  try {
    await dropStale(admin);
    work = mkdtempSync(join(tmpdir(), 'crove-db-types-'));
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    await migrate({ adminUrl: dbUrl, dir: MIGRATIONS });
    const privileges = await tenantPrivileges(dbUrl);
    const { readable } = privileges;
    // Kanel resolves foreign keys while building identifier types (which this script does not use) and warns about
    // every reference to a table left out above. Those warnings are expected; every other one is printed.
    console.warn = (...args) => {
      const ref = args[0] === 'Could not resolve reference' ? args[1] : undefined;
      if (ref && !readable.has(`${ref.schemaName}.${ref.tableName}`)) return;
      warn(...args);
    };
    // Kanel lists the files it writes; it writes only into the temporary directory.
    console.info = () => {};
    await processDatabase({
      connection: dbUrl,
      schemaNames: SCHEMAS,
      // Domains are read only to resolve their base type; no declaration is emitted for them.
      filter: (t) => t.kind === 'domain' || (t.kind === 'table' && readable.has(`${t.schemaName}.${t.name}`)),
      outputPath: work,
      typescriptConfig: { enumStyle: 'literal-union' },
      generators: [
        makePgTsGenerator({
          customTypeMap: TYPE_MAP,
          getMetadata: (details, generateFor, builtin) =>
            details.kind === 'table' && generateFor === 'selector'
              ? { ...builtin, name: tableInterface(details.schemaName, details.name).replace(/Table$/, '') }
              : builtin,
          getPropertyMetadata: (property, _details, _generateFor, builtin) => ({ ...builtin, typeOverride: baseType(property) }),
          propertySortFunction: (a, b) => a.ordinalPosition - b.ordinalPosition,
          preRenderHooks: [makeKyselyHook({ databaseFilename: 'Database', includeSchemaNameInTableName: true })],
        }),
      ],
      preRenderHooks: [singleFile(join(work, 'database'), privileges)],
    });
    const files = readdirSync(work);
    if (files.length !== 1 || files[0] !== 'database.ts') throw new Error(`db-types: unexpected output ${files.join(', ')}`);
    writeFileSync(join(ROOT, OUTPUT), render(readFileSync(join(work, 'database.ts'), 'utf8')));
    console.log(`db-types: wrote ${OUTPUT} (${readable.size} tables)`);
  } finally {
    console.warn = warn;
    console.info = info;
    if (work) rmSync(work, { recursive: true, force: true });
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch((error) => console.error(error));
    await admin.end().catch(() => {});
  }
}

// A run killed before its finally (Ctrl-C) leaves its database behind; the next run drops those older than an hour.
async function dropStale(admin) {
  const { rows } = await admin.query("SELECT datname FROM pg_catalog.pg_database WHERE datname ~ '^crove_types_[0-9]+_[0-9a-f]{8}$'");
  for (const { datname } of rows) {
    if (Date.now() - Number(datname.split('_')[2]) > 3_600_000) {
      // Another run may be dropping it at the same time; a leftover is not worth failing this run.
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`).catch((error) => console.warn(`db-types: could not drop ${datname}: ${error.message}`));
    }
  }
}

await main();
