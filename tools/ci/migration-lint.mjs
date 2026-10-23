// Migration content lint (G2 migration-lint, plan §5.5 and §10; issue #1201). Every migration not on the allowlist must:
//   no-concurrently       not use CONCURRENTLY: the runner applies each file in one transaction, where it fails;
//   no-transaction        not BEGIN, COMMIT, ROLLBACK or END: the runner owns the transaction;
//   no-drop-schema        not DROP SCHEMA;
//   no-truncate           not TRUNCATE;
//   no-public-grant       not GRANT to anon, authenticated or PUBLIC;
//   policy-drop-first     DROP POLICY IF EXISTS <name> ON <table> before every CREATE POLICY <name> ON <table>;
//   module-schema         touch only the schema of the file's module (<version>_crove_<module>_<desc>.sql touches
//                         crove_<module>), with every object it creates, alters, drops, comments on, grants on or
//                         writes qualified by that schema. A statement may touch another crove_* schema only with
//                         a waiver comment on the line right before it, `-- migration-lint: cross-module <reason>`,
//                         with a reason; the lint lists every waiver it accepted (decision on #1213: Social adds its
//                         tables to crove_kernel.org_purge in its own feature migration, as the owner allowed);
//   function-revoke       REVOKE ALL ON FUNCTION <name> ... FROM PUBLIC after every CREATE FUNCTION or PROCEDURE.
// DO bodies are linted too: their PL/pgSQL is split into statements and each SQL statement is checked like a top-level
// one, and so is a string an EXECUTE runs when it reads as a SQL command. Function bodies are not: they run when the
// function is called, not when the migration is applied.
//
// The plan names libpg-query for this. This lint uses its own small lexer instead (comments, strings, quoted
// identifiers and dollar quoting), so it needs no dependency and runs in the Docs check job without an install. The
// rules are about statement shapes, which the lexer and the statement splitter recognise; a full parse tree adds
// nothing they need.
//
// Files already on main when the lint landed cannot be edited (the runner checks their hash), so they are listed in
// tools/ci/migration-lint-allowlist.txt and skipped. CI reads the allowlist from the base branch, so a PR cannot
// exempt its own file by adding it there.
//
// Usage: node tools/ci/migration-lint.mjs [--allowlist-ref <ref>] [--since <ref> | file...]
//   Lints every supabase/migrations/*.sql not on the allowlist, or only the named files, or with --since only the
//   ones HEAD adds or changes since that ref (CI passes the merge commit's first parent, as for migration-order.mjs, so
//   a file that reached main without the lint never fails other PRs). --allowlist-ref reads the allowlist from that
//   git ref (CI passes the base branch) instead of the working tree; a ref without the file means an empty allowlist.
//   Exits 1 and prints one ::error line per finding with the file, line and rule.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = 'supabase/migrations/';
const ALLOWLIST = 'tools/ci/migration-lint-allowlist.txt';
const MODULE = /^\d{14}_crove_([a-z0-9]+)_[a-z0-9_]+\.sql$/;
const BANNED_GRANTEES = new Set(['anon', 'authenticated', 'public']);
const TRANSACTION_WORDS = new Set(['begin', 'start', 'commit', 'end', 'rollback', 'abort']);
// Words that start a SQL command: a string an EXECUTE runs is linted only when it starts with one.
const COMMANDS = new Set([
  'alter', 'analyze', 'begin', 'cluster', 'comment', 'commit', 'create', 'delete', 'do', 'drop', 'end', 'grant',
  'insert', 'merge', 'refresh', 'reindex', 'revoke', 'rollback', 'security', 'truncate', 'update', 'vacuum',
]);

// --- Lexer -------------------------------------------------------------------------------------------------------

// Tokens: { t: 'word' | 'qident' | 'string' | 'punct' | 'other', v, line, body? }. A word's v is lowercased; a
// quoted identifier keeps its case. A string's body is its content, with bodyLine the line it starts on. Line
// comments are pushed to `comments` as { line, text } when it is given.
export function lex(sql, firstLine = 1, comments = undefined) {
  const tokens = [];
  let i = 0;
  let line = firstLine;
  const n = sql.length;
  const advance = (to) => {
    for (let k = i; k < to; k++) if (sql[k] === '\n') line++;
    i = to;
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r' || c === '\f') {
      advance(i + 1);
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      comments?.push({ line, text: sql.slice(i, end === -1 ? n : end).trim() });
      advance(end === -1 ? n : end);
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (sql[k] === '/' && sql[k + 1] === '*') (depth++, (k += 2));
        else if (sql[k] === '*' && sql[k + 1] === '/') (depth--, (k += 2));
        else k++;
      }
      advance(k);
    } else if (c === "'" || ((c === 'e' || c === 'E') && next === "'")) {
      const escapes = c !== "'";
      const start = escapes ? i + 2 : i + 1;
      let k = start;
      while (k < n) {
        if (escapes && sql[k] === '\\') k += 2;
        else if (sql[k] === "'" && sql[k + 1] === "'") k += 2;
        else if (sql[k] === "'") break;
        else k++;
      }
      const tokenLine = line;
      tokens.push({ t: 'string', v: sql.slice(i, k + 1), body: sql.slice(start, k).replaceAll("''", "'"), line: tokenLine, bodyLine: tokenLine });
      advance(k + 1);
    } else if (c === '"') {
      let k = i + 1;
      while (k < n) {
        if (sql[k] === '"' && sql[k + 1] === '"') k += 2;
        else if (sql[k] === '"') break;
        else k++;
      }
      tokens.push({ t: 'qident', v: sql.slice(i + 1, k).replaceAll('""', '"'), line });
      advance(k + 1);
    } else if (c === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i, i + 64))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))[0];
      const start = i + tag.length;
      const end = sql.indexOf(tag, start);
      const stop = end === -1 ? n : end;
      const tokenLine = line;
      const bodyLine = tokenLine + (sql.slice(i, start).split('\n').length - 1);
      tokens.push({ t: 'string', v: sql.slice(i, stop + tag.length), body: sql.slice(start, stop), line: tokenLine, bodyLine });
      advance(end === -1 ? n : stop + tag.length);
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[k])) k++;
      tokens.push({ t: 'word', v: sql.slice(i, k).toLowerCase(), line });
      advance(k);
    } else if (/[0-9]/.test(c)) {
      let k = i + 1;
      while (k < n && /[0-9.eE_]/.test(sql[k])) k++;
      tokens.push({ t: 'other', v: sql.slice(i, k), line });
      advance(k);
    } else {
      tokens.push({ t: 'punct', v: c, line });
      advance(i + 1);
    }
  }
  return tokens;
}

const isWord = (token, ...words) => token?.t === 'word' && (words.length === 0 || words.includes(token.v));
const isPunct = (token, v) => token?.t === 'punct' && token.v === v;

// Splits tokens into statements at semicolons. A SQL-standard function body (BEGIN ATOMIC ... END) holds semicolons
// of its own, so the split waits for its END.
export function splitStatements(tokens) {
  const statements = [];
  let current = [];
  let atomic = 0;
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (isWord(token, 'begin') && isWord(tokens[k + 1], 'atomic')) atomic++;
    else if (atomic > 0 && isWord(token, 'case')) atomic++;
    else if (atomic > 0 && isWord(token, 'end')) atomic--;
    if (isPunct(token, ';') && atomic === 0) {
      if (current.length > 0) statements.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

// --- PL/pgSQL ----------------------------------------------------------------------------------------------------

// Index of the first word in `words` at paren depth 0 from `from`, or -1.
function findWord(tokens, from, ...words) {
  let depth = 0;
  for (let k = from; k < tokens.length; k++) {
    if (isPunct(tokens[k], '(') || isPunct(tokens[k], '[')) depth++;
    else if (isPunct(tokens[k], ')') || isPunct(tokens[k], ']')) depth--;
    else if (depth === 0 && isWord(tokens[k], ...words)) return k;
  }
  return -1;
}

// Strips the PL/pgSQL control structure in front of a statement (labels, BEGIN, DECLARE, IF ... THEN, LOOP heads,
// EXCEPTION WHEN ... THEN, END IF), leaving the statement it guards. Returns [] for a piece that is only structure.
export function stripControl(tokens) {
  let rest = tokens;
  for (;;) {
    const head = rest[0];
    if (head === undefined) return rest;
    if (isPunct(head, '<') && isPunct(rest[1], '<')) {
      const close = rest.findIndex((token, k) => k > 1 && isPunct(token, '>') && isPunct(rest[k + 1], '>'));
      rest = close === -1 ? [] : rest.slice(close + 2);
    } else if (isWord(head, 'begin', 'declare', 'else', 'loop')) {
      rest = rest.slice(1);
    } else if (isWord(head, 'end')) {
      rest = rest.slice(isWord(rest[1], 'if', 'loop', 'case') ? 2 : 1);
    } else if (isWord(head, 'exception') && isWord(rest[1], 'when')) {
      rest = rest.slice(1);
    } else if (isWord(head, 'if', 'elsif', 'elseif', 'when', 'case')) {
      const then = findWord(rest, 1, 'then');
      if (then === -1) return rest;
      rest = rest.slice(then + 1);
    } else if (isWord(head, 'for', 'foreach', 'while')) {
      const loop = findWord(rest, 1, 'loop');
      if (loop === -1) return rest;
      rest = rest.slice(loop + 1);
    } else {
      return rest;
    }
  }
}

// --- Statement shapes --------------------------------------------------------------------------------------------

// A possibly qualified name at `k`: { schema, name, end } (schema undefined when unqualified), or undefined. In SQL
// an EXECUTE builds with format(), a %I or %s placeholder stands for a name: `crove_social.%I` names the schema, and
// a bare placeholder (which may hold a qualified name) is { dynamic: true }, which no rule judges.
function qualifiedName(tokens, k) {
  const ident = (token) => token?.t === 'word' || token?.t === 'qident';
  const placeholder = (j) => isPunct(tokens[j], '%') && tokens[j + 1]?.t === 'word';
  if (placeholder(k)) return { dynamic: true, name: `%${tokens[k + 1].v}`, end: k + 2 };
  if (!ident(tokens[k])) return undefined;
  if (isPunct(tokens[k + 1], '.') && placeholder(k + 2)) {
    return { schema: tokens[k].v, name: `%${tokens[k + 3].v}`, end: k + 4 };
  }
  if (isPunct(tokens[k + 1], '.') && ident(tokens[k + 2])) {
    return { schema: tokens[k].v, name: tokens[k + 2].v, end: k + 3 };
  }
  return { schema: undefined, name: tokens[k].v, end: k + 1 };
}

// Skips a parenthesised group starting at `k` (if any) and returns the index after it.
function skipParens(tokens, k) {
  if (!isPunct(tokens[k], '(')) return k;
  let depth = 0;
  for (let j = k; j < tokens.length; j++) {
    if (isPunct(tokens[j], '(')) depth++;
    else if (isPunct(tokens[j], ')') && --depth === 0) return j + 1;
  }
  return tokens.length;
}

// Comma-separated object names from `k` (each optionally followed by an argument list), stopping at `stop` words.
function nameList(tokens, k, ...stop) {
  const names = [];
  let j = k;
  while (j < tokens.length && !isWord(tokens[j], ...stop)) {
    const name = qualifiedName(tokens, j);
    if (!name) break;
    names.push({ ...name, line: tokens[j].line });
    j = skipParens(tokens, name.end);
    if (!isPunct(tokens[j], ',')) break;
    j++;
  }
  return names;
}

const skipWords = (tokens, k, ...words) => {
  let j = k;
  while (isWord(tokens[j], ...words)) j++;
  return j;
};

// skips IF [NOT] EXISTS
const skipIfExists = (tokens, k) => {
  if (!isWord(tokens[k], 'if')) return k;
  return isWord(tokens[k + 1], 'not') ? k + 3 : k + 2;
};

// Object kinds that ALTER, DROP, COMMENT ON and SECURITY LABEL ON name by a qualified name.
const OBJECT_KINDS = new Set([
  'table', 'view', 'sequence', 'index', 'function', 'procedure', 'routine', 'aggregate', 'type', 'domain',
  'materialized', 'foreign', 'collation', 'conversion', 'operator', 'statistics', 'text',
]);
// Kinds named as `<name> ON <table>`: the table is what is touched.
const ON_TABLE_KINDS = new Set(['trigger', 'policy', 'rule', 'constraint']);

// The objects a statement touches: [{ schema, name, line }]; `schemas` are schemas named whole (CREATE SCHEMA,
// GRANT ... ON SCHEMA, ... IN SCHEMA). Function calls (SELECT f(), PERFORM) are not touches.
export function touchedObjects(tokens) {
  const objects = [];
  const schemas = [];
  const head = tokens[0];
  if (!head || head.t !== 'word') return { objects, schemas };
  const word = (k) => (tokens[k]?.t === 'word' ? tokens[k].v : undefined);
  const push = (name) => name && objects.push({ ...name, line: tokens[0].line });
  const onTable = (k) => {
    const on = findWord(tokens, k, 'on');
    if (on !== -1) push(qualifiedName(tokens, skipWords(tokens, on + 1, 'only')));
  };
  const named = (k) => {
    // k points at an object kind word; returns the index of the name after the kind words and IF [NOT] EXISTS.
    let j = k;
    if (word(j) === 'materialized' || word(j) === 'foreign') j++;
    if (word(j) === 'text' && word(j + 1) === 'search') j += 3;
    else j++;
    return skipIfExists(tokens, skipWords(tokens, j, 'concurrently'));
  };

  switch (head.v) {
    case 'create': {
      let k = skipWords(tokens, 1, 'or', 'replace', 'temp', 'temporary', 'unlogged', 'unique', 'recursive', 'trusted', 'procedural', 'constraint');
      const kind = word(k);
      if (kind === 'schema') {
        const name = tokens[skipIfExists(tokens, k + 1)];
        if (name) schemas.push({ schema: name.v, line: head.line });
      } else if (kind === 'index') {
        onTable(k + 1);
      } else if (kind === 'trigger' || kind === 'policy' || kind === 'rule') {
        onTable(k + 1);
      } else if (kind === 'extension') {
        const at = findWord(tokens, k + 1, 'schema');
        if (at !== -1 && tokens[at + 1]) schemas.push({ schema: tokens[at + 1].v, line: head.line });
        else schemas.push({ schema: undefined, line: head.line, what: 'CREATE EXTENSION without WITH SCHEMA' });
      } else if (kind !== undefined && kind !== 'role' && kind !== 'user' && kind !== 'group' && kind !== 'publication' && kind !== 'subscription' && kind !== 'event') {
        push(qualifiedName(tokens, named(k)));
      }
      break;
    }
    case 'alter': {
      const kind = word(1);
      if (kind === 'default') {
        const at = findWord(tokens, 2, 'schema');
        if (at !== -1) schemas.push({ schema: tokens[at + 1]?.v, line: head.line });
      } else if (kind === 'schema') {
        schemas.push({ schema: tokens[2]?.v, line: head.line });
      } else if (kind === 'trigger' || kind === 'policy' || kind === 'rule') {
        onTable(2);
      } else if (kind !== undefined && OBJECT_KINDS.has(kind)) {
        push(qualifiedName(tokens, skipWords(tokens, named(1), 'only')));
      }
      break;
    }
    case 'drop': {
      const kind = word(1);
      if (kind === 'schema') {
        for (const name of nameList(tokens, skipIfExists(tokens, 2), 'cascade', 'restrict')) schemas.push({ schema: name.name, line: head.line });
      } else if (kind !== undefined && ON_TABLE_KINDS.has(kind)) {
        onTable(2);
      } else if (kind !== undefined && OBJECT_KINDS.has(kind)) {
        for (const name of nameList(tokens, named(1), 'cascade', 'restrict')) objects.push(name);
      }
      break;
    }
    case 'comment':
    case 'security': {
      const on = findWord(tokens, 1, 'on');
      const kind = word(on + 1);
      if (on === -1 || kind === undefined) break;
      if (kind === 'schema') schemas.push({ schema: tokens[on + 2]?.v, line: head.line });
      else if (ON_TABLE_KINDS.has(kind)) onTable(on + 3);
      else if (kind === 'column') push(qualifiedName(tokens, on + 2));
      else if (OBJECT_KINDS.has(kind)) push(qualifiedName(tokens, named(on + 1)));
      break;
    }
    case 'grant':
    case 'revoke': {
      const on = findWord(tokens, 1, 'on', 'to', 'from');
      if (on === -1 || !isWord(tokens[on], 'on')) break; // a role membership grant
      let k = on + 1;
      if (word(k) === 'all') {
        const at = findWord(tokens, k, 'schema');
        if (at !== -1) for (const name of nameList(tokens, at + 1, 'to', 'from')) schemas.push({ schema: name.name, line: head.line });
        break;
      }
      if (word(k) === 'schema') {
        for (const name of nameList(tokens, k + 1, 'to', 'from')) schemas.push({ schema: name.name, line: head.line });
        break;
      }
      if (word(k) === 'large' || word(k) === 'database' || word(k) === 'tablespace' || word(k) === 'language' || word(k) === 'foreign' || word(k) === 'parameter') break;
      k = skipWords(tokens, k, 'table', 'sequence', 'function', 'procedure', 'routine', 'type', 'domain');
      for (const name of nameList(tokens, k, 'to', 'from')) objects.push(name);
      break;
    }
    case 'insert':
    case 'merge':
      if (isWord(tokens[1], 'into')) push(qualifiedName(tokens, 2));
      break;
    case 'delete':
      if (isWord(tokens[1], 'from')) push(qualifiedName(tokens, skipWords(tokens, 2, 'only')));
      break;
    case 'update':
      push(qualifiedName(tokens, skipWords(tokens, 1, 'only')));
      break;
    case 'refresh':
      push(qualifiedName(tokens, skipWords(tokens, 3, 'concurrently')));
      break;
    default:
      break;
  }
  return { objects, schemas };
}

// The roles a GRANT (or ALTER DEFAULT PRIVILEGES ... GRANT) gives to.
function grantees(tokens, from) {
  const to = findWord(tokens, from, 'to');
  if (to === -1) return [];
  const roles = [];
  for (let k = to + 1; k < tokens.length; k++) {
    if (isWord(tokens[k], 'with', 'granted')) break;
    if (isWord(tokens[k], 'group')) continue;
    if (tokens[k].t === 'word' || tokens[k].t === 'qident') roles.push({ role: tokens[k].t === 'word' ? tokens[k].v : tokens[k].v.toLowerCase(), line: tokens[k].line });
  }
  return roles;
}

// Raw text of tokens, for keys that must match placeholders (%I) as well as literal names.
const text = (tokens) => tokens.map((token) => (token.t === 'qident' ? `"${token.v}"` : token.v)).join('');

// "<policy>|<table>" for CREATE POLICY and DROP POLICY: the policy name and the table after ON.
function policyKey(tokens, nameAt) {
  const on = findWord(tokens, nameAt, 'on');
  if (on === -1) return undefined;
  let end = on + 1;
  while (end < tokens.length && !isWord(tokens[end], 'as', 'for', 'to', 'using', 'with', 'cascade', 'restrict')) end++;
  return `${text(tokens.slice(nameAt, on))}|${text(tokens.slice(on + 1, end))}`;
}

// --- Rules -------------------------------------------------------------------------------------------------------

// The module a migration file belongs to (crove_<module>), from its name, or undefined.
export function moduleOf(file) {
  return MODULE.exec(basename(file))?.[1];
}

// The functions and procedures a migration creates, as "<schema>.<name>" (overloads share a key).
export function functionsCreated(sql) {
  const keys = new Set();
  for (const tokens of splitStatements(lex(sql))) {
    if (!isWord(tokens[0], 'create')) continue;
    const k = skipWords(tokens, 1, 'or', 'replace');
    const name = isWord(tokens[k], 'function', 'procedure') ? qualifiedName(tokens, k + 1) : undefined;
    if (name) keys.add(`${name.schema ?? ''}.${name.name}`);
  }
  return keys;
}

const WAIVER = /^--\s*migration-lint:\s*cross-module(?:\s+(.*))?$/;

// Lints one migration. Returns [{ file, line, rule, message }], in file order. `existingFunctions` are the keys of
// functions earlier migrations created (functionsCreated): CREATE OR REPLACE keeps a function's privileges, so only a
// new function needs its REVOKE. Matching is by name, so a new overload of an existing function is not caught. Each
// cross-module waiver the lint accepts is pushed to `waivers` as { file, line, schemas, reason }.
export function lintMigration(file, sql, { existingFunctions = new Set(), waivers = /** @type {{ file: string, line: number, schemas: string[], reason: string }[]} */ ([]) } = {}) {
  const findings = [];
  const module = moduleOf(file);
  const schema = module === undefined ? undefined : `crove_${module}`;
  const report = (line, rule, message) => findings.push({ file, line, rule, message });
  const droppedPolicies = new Set();
  const functions = []; // { key, line }: functions created, waiting for their REVOKE
  const revoked = []; // { key | schema, index }: REVOKE ALL ... FROM PUBLIC, in order
  let order = 0;
  const comments = [];
  const waiverAt = new Map(); // line of the statement a waiver comment precedes -> { line, reason }
  const collectWaivers = () => {
    for (const { line, text } of comments.splice(0)) {
      const match = WAIVER.exec(text);
      if (match) waiverAt.set(line + 1, { line, reason: (match[1] ?? '').trim() });
    }
  };

  if (schema === undefined) report(1, 'module-schema', `the file name does not match <14-digit version>_crove_<module>_<description>.sql, so its module is unknown`);

  // `waiver` is the cross-module waiver on the line before the statement, if any; `waived` collects the schemas it
  // covered. A waiver covers only crove_* schemas: no module touches public, auth or extensions.
  const checkSchema = (name, line, what, waiver, waived) => {
    if (schema === undefined) return;
    if (name === undefined) {
      report(line, 'module-schema', `${what} is not qualified by a schema; write ${schema}.<name>`);
    } else if (name !== schema) {
      if (waiver?.reason && name.startsWith('crove_')) {
        waived.add(name);
        return;
      }
      const why = waiver === undefined
        ? `put that change in a crove_${name.replace(/^crove_/, '')} migration, or put \`-- migration-lint: cross-module <reason>\` on the line before the statement`
        : waiver.reason ? 'a waiver covers only crove_* schemas' : `the waiver on line ${waiver.line} has no reason`;
      report(line, 'module-schema', `touches schema ${name}, but this file belongs to ${schema}; ${why}`);
    }
  };

  const lintStatement = (raw, nested) => {
    const tokens = nested ? stripControl(raw) : raw;
    const head = tokens[0];
    if (!head) return;
    order++;

    for (const token of tokens) {
      if (isWord(token, 'concurrently')) report(token.line, 'no-concurrently', 'CONCURRENTLY cannot run in the transaction the runner applies each migration in');
    }

    if (head.t === 'word' && TRANSACTION_WORDS.has(head.v) && (!nested || head.v === 'commit' || head.v === 'rollback')) {
      if (head.v !== 'start' || isWord(tokens[1], 'transaction')) report(head.line, 'no-transaction', `${head.v.toUpperCase()}: the runner applies each migration in its own transaction; transaction control is not allowed`);
    }
    if (isWord(head, 'drop') && isWord(tokens[1], 'schema')) report(head.line, 'no-drop-schema', 'DROP SCHEMA is not allowed in a migration');
    if (isWord(head, 'truncate')) report(head.line, 'no-truncate', 'TRUNCATE is not allowed in a migration');

    if (isWord(head, 'grant') || (isWord(head, 'alter') && isWord(tokens[1], 'default'))) {
      const at = isWord(head, 'grant') ? 0 : findWord(tokens, 2, 'grant');
      if (at !== -1) {
        for (const { role, line } of grantees(tokens, at + 1)) {
          if (BANNED_GRANTEES.has(role)) report(line, 'no-public-grant', `GRANT to ${role} is not allowed; grant to the Crove roles that need it`);
        }
      }
    }

    if (isWord(head, 'drop') && isWord(tokens[1], 'policy') && isWord(tokens[2], 'if') && isWord(tokens[3], 'exists')) {
      const key = policyKey(tokens, 4);
      if (key) droppedPolicies.add(key);
    }
    if (isWord(head, 'create') && isWord(tokens[1], 'policy')) {
      const key = policyKey(tokens, 2);
      if (key && !droppedPolicies.has(key)) {
        report(head.line, 'policy-drop-first', `CREATE POLICY ${key.replace('|', ' ON ')} needs DROP POLICY IF EXISTS ${key.replace('|', ' ON ')} before it, so the file can be re-applied`);
      }
    }

    if (isWord(head, 'create')) {
      const k = skipWords(tokens, 1, 'or', 'replace');
      if (isWord(tokens[k], 'function', 'procedure')) {
        const name = qualifiedName(tokens, k + 1);
        if (name) functions.push({ key: `${name.schema ?? ''}.${name.name}`, schema: name.schema, label: name.schema ? `${name.schema}.${name.name}` : name.name, line: head.line, index: order });
      }
    }
    if (isWord(head, 'revoke')) {
      const from = findWord(tokens, 1, 'from');
      const publicToo = from !== -1 && tokens.slice(from + 1).some((token) => isWord(token, 'public'));
      const on = findWord(tokens, 1, 'on');
      if (publicToo && on !== -1 && isWord(tokens[1], 'all')) {
        if (isWord(tokens[on + 1], 'all') && isWord(tokens[on + 2], 'functions', 'procedures', 'routines')) {
          const at = findWord(tokens, on + 3, 'schema');
          for (const name of at === -1 ? [] : nameList(tokens, at + 1, 'from')) revoked.push({ schema: name.name, index: order });
        } else if (isWord(tokens[on + 1], 'function', 'procedure', 'routine')) {
          for (const name of nameList(tokens, on + 2, 'from')) revoked.push({ key: `${name.schema ?? ''}.${name.name}`, index: order });
        }
      }
    }

    const { objects, schemas } = touchedObjects(tokens);
    const waiver = waiverAt.get(head.line);
    const waived = new Set();
    for (const object of objects) if (!object.dynamic) checkSchema(object.schema, object.line, object.name, waiver, waived);
    for (const named of schemas) if (!named.schema?.startsWith('%')) checkSchema(named.schema, named.line, named.what ?? 'the schema', waiver, waived);
    if (waived.size > 0) waivers.push({ file, line: head.line, schemas: [...waived].sort(), reason: waiver.reason });

    // DO bodies, and SQL an EXECUTE runs from a string literal.
    if (isWord(head, 'do')) {
      const body = tokens.find((token) => token.t === 'string');
      if (body) {
        const statements = splitStatements(lex(body.body, body.bodyLine, comments));
        collectWaivers();
        for (const statement of statements) lintStatement(statement, true);
      }
    } else if (nested && isWord(head, 'execute')) {
      for (const token of tokens) {
        if (token.t !== 'string') continue;
        const inner = lex(token.body, token.bodyLine);
        if (inner[0]?.t === 'word' && COMMANDS.has(inner[0].v)) for (const statement of splitStatements(inner)) lintStatement(statement, false);
      }
    }
  };

  const statements = splitStatements(lex(sql, 1, comments));
  collectWaivers();
  for (const statement of statements) lintStatement(statement, false);

  for (const fn of functions) {
    if (existingFunctions.has(fn.key)) continue;
    const done = revoked.some((r) => r.index > fn.index && (r.key === fn.key || (r.schema !== undefined && r.schema === fn.schema)));
    if (!done) report(fn.line, 'function-revoke', `function ${fn.label} needs REVOKE ALL ON FUNCTION ${fn.label}(...) FROM PUBLIC after it, then explicit GRANTs`);
  }
  return findings.sort((a, b) => a.line - b.line);
}

// --- CLI ---------------------------------------------------------------------------------------------------------

export function parseAllowlist(content) {
  return new Set(content.split('\n').map((entry) => entry.replace(/#.*/, '').trim()).filter(Boolean));
}

function readAllowlist(ref) {
  if (ref === undefined) return parseAllowlist(readFileSync(ALLOWLIST, 'utf8'));
  try {
    return parseAllowlist(execFileSync('git', ['show', `${ref}:${ALLOWLIST}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return new Set();
  }
}

export function format({ file, line, rule, message }) {
  return `::error file=${file},line=${line}::${file}:${line} [${rule}] ${message}`;
}

export function formatWaiver({ file, line, schemas, reason }) {
  return `::notice file=${file},line=${line}::${file}:${line} cross-module waiver for ${schemas.join(', ')}: ${reason}`;
}

// Takes `--name value` out of args.
function option(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const [, value] = args.splice(at, 2);
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

// The migration files to lint and, for each, the functions the migrations before it created.
export function plan(allNames, selected, allowlist) {
  const sorted = [...allNames].filter((name) => name.endsWith('.sql')).sort();
  const wanted = new Set(selected ?? sorted);
  return sorted.filter((name) => wanted.has(name) && !allowlist.has(name));
}

function main() {
  const args = process.argv.slice(2);
  const ref = option(args, '--allowlist-ref');
  const since = option(args, '--since');
  const allowlist = readAllowlist(ref);
  const all = readdirSync(DIR);
  const selected = since !== undefined
    ? execFileSync('git', ['diff', '--name-only', '--no-renames', '--diff-filter=AM', since, 'HEAD', '--', DIR], { encoding: 'utf8' }).split('\n').filter(Boolean).map((path) => basename(path))
    : args.length > 0 ? args.map((path) => basename(path)) : undefined;
  const names = plan(all, selected, allowlist);
  const existing = new Map(); // name -> the functions every earlier file created
  const known = new Set();
  for (const name of [...all].filter((n) => n.endsWith('.sql')).sort()) {
    existing.set(name, new Set(known));
    for (const key of functionsCreated(readFileSync(DIR + name, 'utf8'))) known.add(key);
  }
  const files = names.map((name) => DIR + name);
  const waivers = [];
  const findings = names.flatMap((name) => lintMigration(DIR + name, readFileSync(DIR + name, 'utf8'), { existingFunctions: existing.get(name), waivers }));
  // Every accepted waiver, so reviewers see each cross-module change: as annotations and in the job summary.
  for (const waiver of waivers) console.log(formatWaiver(waiver));
  if (waivers.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
    const rows = waivers.map((w) => `| \`${w.file}:${w.line}\` | ${w.schemas.join(', ')} | ${w.reason.replaceAll('|', '\\|')} |`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Cross-module waivers', '', '| Statement | Schemas | Reason |', '|---|---|---|', ...rows, ''].join('\n'));
  }
  for (const finding of findings) console.error(format(finding));
  if (findings.length > 0) {
    console.error(`migration lint: ${findings.length} finding(s) in ${new Set(findings.map((f) => f.file)).size} file(s); the rules are in tools/ci/migration-lint.mjs`);
    process.exitCode = 1;
    return;
  }
  console.log(`migration lint OK: ${files.length} file(s) checked, ${waivers.length} cross-module waiver(s), ${allowlist.size} on the allowlist`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
