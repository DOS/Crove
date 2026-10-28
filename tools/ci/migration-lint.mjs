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
//   function-revoke       REVOKE ALL ON FUNCTION <name> ... FROM PUBLIC after every new CREATE FUNCTION or PROCEDURE
//                         (one no earlier migration created, or one this file dropped first);
//   contract-header       put `-- crove:contract adr=<id>` (the ADR that records the change, a file in docs/adr) on the
//                         comment lines right before every contract change (plan §3.5 and §5.5, #1693): every DROP
//                         (OWNED, COLLATION, CAST and the rest too, #1709), any RENAME or SET SCHEMA, a DROP COLUMN or
//                         ATTRIBUTE, and a column or attribute type change (a DROP and CREATE of the same name too).
//                         One header covers one statement. Indexes, constraints, triggers, event triggers, policies,
//                         rules and statistics are internals, not contract; nor is dropping a helper a top-level
//                         statement of this file created (a routine with the same argument list);
//   hot-table-retry       run DDL that locks a hot table (crove_jobs.*, crove_kernel.outbox_*, audit_event, record,
//                         idempotency_key, processed_message; plan §5.5, #1693) directly inside the lock-retry block,
//                         in the shape of the plan's template (retryBlocks): a BEGIN ... EXCEPTION ... END block in a
//                         bare LOOP, which sets a local lock_timeout of 1 ms to 1 min in a statement directly in it
//                         before the statement, with nothing that may change it in between (#1709), EXITs directly in
//                         it after the statement, and whose lock_not_available branch (with no OTHERS before or in it)
//                         counts a counter declared as 0 and re-raises once it reaches a bound. DDL that locks a table
//                         includes CREATE RULE ... TO, CREATE STATISTICS ... FROM, ATTACH or DETACH PARTITION and
//                         [NO] INHERIT. A table a top-level plain CREATE TABLE of this file made is not hot yet;
//   no-edit-applied       with --since, not change or delete a migration that is already on the base branch.
// contract-header and hot-table-retry skip the files up to BREAKING_RULES_AFTER (20261103090000), the newest of the 262
// on main when they landed.
// DO bodies are linted too: their PL/pgSQL is split into statements and each SQL statement is checked like a top-level
// one, and so is every statement of the command string an EXECUTE runs. Function bodies are not: they run when the
// function is called, not when the migration is applied.
//
// Known blind spots (the lint reads statement shapes; the invariant suite and the security review cover the rest):
//   - writes in a CTE (WITH d AS (DELETE FROM ...) SELECT ...) and SELECT ... INTO a new table;
//   - ALTER ... SET SCHEMA and ALTER ... OWNER TO, which move or hand over an object without touching its schema rule;
//   - PREPARE TRANSACTION;
//   - EXECUTE of a variable or an expression (only a string literal, or format()'s literal format string, is read);
//   - a function body the same file then calls (SELECT f()), whose statements run at migration time;
//   - SET standard_conforming_strings = off, which changes how '...' strings end and so where statements split;
//   - a hot table named by a bare placeholder or crove_kernel.%I in an EXECUTE, an index of a hot table whose name
//     does not say so, a hot table locked by a function the file calls (apply_tenant_rls and the like), and the
//     table of ALTER or DROP STATISTICS (the statistics object's name does not say it);
//   - a contract change whose command words come from a placeholder (EXECUTE format('DROP %s ...', 'TABLE'));
//   - a lock_timeout changed between its setting and the statement by a function the block calls, or by the
//     statement itself when it is an EXECUTE of a string built from pieces ('SET LOCAL lock_' || 'timeout = 0; ...');
//   - argument types written as different aliases than the lint knows (TYPE_ALIASES), which only makes a dropped
//     helper need a header;
//   - an unquoted PL/pgSQL keyword used as a name (SELECT 1 AS loop), which can confuse the block structure.
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
//   ones HEAD adds since that ref, reporting every one it changes or deletes (CI passes the merge commit's first parent,
//   as for migration-order.mjs, so a file that reached main without the lint never fails other PRs). --allowlist-ref reads the allowlist from that
//   git ref (CI passes the base branch) instead of the working tree; a ref without the file means an empty allowlist.
//   Exits 1 and prints one ::error line per finding with the file, line and rule.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = 'supabase/migrations/';
const ALLOWLIST = 'tools/ci/migration-lint-allowlist.txt';
const ADR_DIR = 'docs/adr/';
// contract-header and hot-table-retry (#1693) apply to migrations with a version above this one, the newest of the 262
// on main when they landed: the files up to it cannot be edited (the runner checks each applied file's hash), and
// listing the 62 of them that are not on the allowlist by name would only repeat what their version already says
// (some break them: they predate the rules). With --since, as CI runs, the cutoff is not used: every file a PR adds
// gets every rule, so raising it exempts nothing in CI.
export const BREAKING_RULES_AFTER = '20261103090000';
const MODULE = /^\d{14}_crove_([a-z0-9]+)_[a-z0-9_]+\.sql$/;
const BANNED_GRANTEES = new Set(['anon', 'authenticated', 'public']);
const TRANSACTION_WORDS = new Set(['begin', 'start', 'commit', 'end', 'rollback', 'abort']);

// --- Lexer -------------------------------------------------------------------------------------------------------

// Tokens: { t: 'word' | 'qident' | 'string' | 'punct' | 'other', v, line, body? }. A word's v is lowercased; a
// quoted identifier keeps its case. A string's body is its content, with bodyLine the line it starts on. Line
// comments are pushed to `comments` as { line, text, alone } when it is given; `alone` is true when no code comes
// before the comment on its line (`afterCode`: the first line starts after code, as a DO body does after its $).
export function lex(sql, firstLine = 1, comments = undefined, afterCode = false) {
  const tokens = [];
  let i = 0;
  let line = firstLine;
  const n = sql.length;
  const advance = (to) => {
    for (let k = i; k < to; k++) if (sql[k] === '\n') line++;
    i = to;
  };
  let codeLine = afterCode ? firstLine : -1; // the line the last token ended on, so a comment knows whether code comes before it on its line
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    const before = tokens.length;
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r' || c === '\f') {
      advance(i + 1);
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      comments?.push({ line, text: sql.slice(i, end === -1 ? n : end).trim(), alone: codeLine < line });
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
    } else if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[k])) k++;
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
    if (tokens.length > before) codeLine = line;
  }
  return tokens;
}

const isWord = (token, ...words) => token?.t === 'word' && (words.length === 0 || words.includes(token.v));
const isPunct = (token, v) => token?.t === 'punct' && token.v === v;

// Splits tokens into statements at semicolons. A SQL-standard function body (BEGIN ATOMIC ... END) holds semicolons
// of its own, so the split waits for its END; BEGIN ATOMIC counts only in CREATE [OR REPLACE] FUNCTION or PROCEDURE,
// so the words elsewhere (`SELECT begin atomic FROM ...`) cannot swallow the rest of the file.
export function splitStatements(tokens) {
  const statements = [];
  let current = [];
  let atomic = 0;
  const inRoutine = () => isWord(current[0], 'create') && isWord(current[isWord(current[1], 'or') ? 3 : 1], 'function', 'procedure');
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (isWord(token, 'begin') && isWord(tokens[k + 1], 'atomic') && (atomic > 0 || inRoutine())) atomic++;
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

// The table of CREATE [OR REPLACE] RULE <name> AS ON <event> TO <table>, from the word after the kind: the name after
// the TO that follows ON (ON is followed by the event, not the table).
function ruleTable(tokens, k) {
  const on = findWord(tokens, k, 'on');
  const to = on === -1 ? -1 : findWord(tokens, on + 1, 'to');
  return to === -1 ? undefined : qualifiedName(tokens, skipWords(tokens, to + 1, 'only'));
}

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
      } else if (kind === 'trigger' || kind === 'policy') {
        onTable(k + 1);
      } else if (kind === 'rule') {
        push(ruleTable(tokens, k + 1));
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

// "<policy> ON <table>" for CREATE POLICY and DROP POLICY: the policy name and the table after ON, as written.
function policyKey(tokens, nameAt) {
  const on = findWord(tokens, nameAt, 'on');
  if (on === -1) return undefined;
  let end = on + 1;
  while (end < tokens.length && !isWord(tokens[end], 'as', 'for', 'to', 'using', 'with', 'cascade', 'restrict')) end++;
  return `${text(tokens.slice(nameAt, on))} ON ${text(tokens.slice(on + 1, end))}`;
}

// Every DROP is a contract change but of the schema's internals: indexes, constraints, triggers (event triggers too),
// policies, rules and statistics (the idempotent re-create pattern drops them), so dropping or renaming them is not.
// DROP SCHEMA is refused outright (no-drop-schema). A DROP of any other kind (OWNED, COLLATION, CAST, SERVER, ...)
// needs the header.
const INTERNAL_KINDS = new Set(['index', 'trigger', 'policy', 'rule', 'statistics', 'event']);
// The kinds whose DROP names objects a file may have created itself (see helper in lintMigration).
const NAMED_DROP_KINDS = new Set(['table', 'view', 'materialized', 'foreign', 'sequence', 'type', 'domain', 'function', 'procedure', 'routine', 'aggregate']);
const FUNCTION_KINDS = new Set(['function', 'procedure', 'routine', 'aggregate']);
// ALTER of these kinds can add columns or attributes, whose names may read as actions (ADD COLUMN rename text), so
// only the words that start an action count; for the other kinds a RENAME or SET SCHEMA anywhere at depth 0 does.
const COLUMN_KINDS = new Set(['table', 'foreign', 'type', 'view', 'materialized']);
// ALTER TABLE ... DROP <word>: these drop a property of a column or table, not a column.
const NOT_A_COLUMN = new Set(['constraint', 'default', 'not', 'expression', 'identity']);

// The contract change a statement makes (DROP of a contract object, RENAME, SET SCHEMA, DROP COLUMN or ATTRIBUTE, a
// column or attribute type change), as { what, names }, or undefined. `names` are the objects a DROP removes, so the
// caller can tell a helper this file created from one that callers use.
export function breakingChange(tokens) {
  const head = tokens[0];
  if (isWord(head, 'drop')) {
    if (isWord(tokens[1], 'schema') || (isWord(tokens[1]) && INTERNAL_KINDS.has(tokens[1].v))) return undefined;
    const kind = isWord(tokens[1]) ? tokens[1].v : '?';
    if (!NAMED_DROP_KINDS.has(kind)) return { what: `DROP ${kind.toUpperCase()}`, kind, names: [] };
    const at = skipIfExists(tokens, skipWords(tokens, 2, 'view', 'table'));
    const names = nameList(tokens, at, 'cascade', 'restrict').map((name) => ({ ...name, args: signature(tokens, name.end) }));
    return { what: `DROP ${kind.toUpperCase()}`, kind, names };
  }
  if (!isWord(head, 'alter') || !isWord(tokens[1]) || INTERNAL_KINDS.has(tokens[1].v) || isWord(tokens[1], 'default')) return undefined;
  if (!COLUMN_KINDS.has(tokens[1].v)) {
    let depth = 0;
    for (let j = 2; j < tokens.length; j++) {
      if (isPunct(tokens[j], '(')) depth++;
      else if (isPunct(tokens[j], ')')) depth--;
      else if (depth === 0 && isWord(tokens[j], 'rename') && !isWord(tokens[j + 1], 'constraint')) return { what: 'RENAME', names: [] };
      else if (depth === 0 && isWord(tokens[j], 'set') && isWord(tokens[j + 1], 'schema')) return { what: 'SET SCHEMA', names: [] };
    }
    return undefined;
  }
  const dropsColumns = isWord(tokens[1], 'table', 'foreign', 'type');
  // The actions start after the object's name (and a function's argument list) and after each comma at depth 0, so
  // a column named rename or drop is not read as an action.
  let k = isWord(tokens[1], 'materialized', 'foreign') ? 3 : isWord(tokens[1], 'text') ? 4 : 2;
  k = skipWords(tokens, skipIfExists(tokens, k), 'only');
  const name = qualifiedName(tokens, k);
  if (name === undefined) return undefined;
  k = skipParens(tokens, name.end);
  if (isPunct(tokens[k], '*')) k++;
  const actions = [k];
  let depth = 0;
  for (let j = k; j < tokens.length; j++) {
    if (isPunct(tokens[j], '(')) depth++;
    else if (isPunct(tokens[j], ')')) depth--;
    else if (depth === 0 && isPunct(tokens[j], ',')) actions.push(j + 1);
  }
  for (const a of actions) {
    const action = tokens[a];
    if (isWord(action, 'rename') && !isWord(tokens[a + 1], 'constraint')) return { what: 'RENAME', names: [] };
    if (isWord(action, 'set') && isWord(tokens[a + 1], 'schema')) return { what: 'SET SCHEMA', names: [] };
    if (isWord(action, 'drop') && dropsColumns && !isWord(tokens[a + 1], ...NOT_A_COLUMN)) return { what: isWord(tokens[1], 'type') ? 'DROP ATTRIBUTE' : 'DROP COLUMN', names: [] };
    if (isWord(action, 'alter')) {
      // ALTER [COLUMN | ATTRIBUTE] <name> [SET DATA] TYPE
      let j = a + 1;
      if (isWord(tokens[j], 'column', 'attribute')) j++;
      const after = tokens[j + 1];
      if (isWord(after, 'type') || (isWord(after, 'set') && isWord(tokens[j + 2], 'data') && isWord(tokens[j + 3], 'type'))) return { what: 'a type change', names: [] };
    }
  }
  return undefined;
}

// Type names written two ways, so a DROP's argument list matches the CREATE's however each spells them.
const TYPE_ALIASES = new Map([
  ['int', 'integer'], ['int4', 'integer'], ['int8', 'bigint'], ['int2', 'smallint'], ['bool', 'boolean'], ['float4', 'real'],
  ['float8', 'double precision'], ['decimal', 'numeric'], ['varchar', 'character varying'], ['timestamptz', 'timestamp with time zone'],
  ['timetz', 'time with time zone'],
]);

// The argument list of a routine signature at the ( at `k`, for matching a DROP with the CREATE it undoes: for each
// argument but OUT ones (DROP ignores them), the ways it may be written, with and without its name (one of them its
// type alone). Undefined when there is no list.
export function signature(tokens, k) {
  if (!isPunct(tokens[k], '(')) return undefined;
  const end = skipParens(tokens, k) - 1;
  const args = [];
  let current = [];
  let depth = 0;
  for (let j = k + 1; j < end; j++) {
    if (isPunct(tokens[j], '(') || isPunct(tokens[j], '[')) depth++;
    else if (isPunct(tokens[j], ')') || isPunct(tokens[j], ']')) depth--;
    if (depth === 0 && isPunct(tokens[j], ',')) {
      args.push(current);
      current = [];
    } else {
      current.push(tokens[j]);
    }
  }
  if (current.length > 0) args.push(current);
  return args.flatMap((arg) => {
    let rest = arg;
    const stop = rest.findIndex((t) => isWord(t, 'default') || isPunct(t, '='));
    if (stop !== -1) rest = rest.slice(0, stop);
    if (isWord(rest[0], 'out')) return [];
    if (isWord(rest[0], 'in', 'inout', 'variadic') && rest.length > 1) rest = rest.slice(1);
    rest = rest.filter((t, j) => !(isWord(t, 'pg_catalog') && isPunct(rest[j + 1], '.')) && !(isPunct(t, '.') && isWord(rest[j - 1], 'pg_catalog')));
    const spell = (ts) => ts.map((t) => (t.t === 'qident' ? `"${t.v}"` : t.t === 'word' ? TYPE_ALIASES.get(t.v) ?? t.v : t.v)).join(' ');
    const ways = [spell(rest)];
    if (rest.length > 1 && (rest[0].t === 'word' || rest[0].t === 'qident')) ways.push(spell(rest.slice(1)));
    return [ways];
  });
}

// Whether two argument lists (signature) name the same routine: as many arguments, each written one same way.
export const sameSignature = (a, b) => a.length === b.length && a.every((ways, i) => ways.some((way) => b[i].includes(way)));

// Hot tables (plan §5.5): DDL on them waits behind every open transaction that uses them and queues every later one
// behind itself, so it runs in the lock-retry block. Index names are matched like table names, so an index of a hot
// table is recognised only when its name is (crove_jobs.*, outbox_*).
const HOT_KERNEL = /^(outbox_.*|audit_event|record|idempotency_key|processed_message)$/;
export const isHotTable = ({ schema, name }) => schema === 'crove_jobs' || (schema === 'crove_kernel' && HOT_KERNEL.test(name));

// The existing tables a DDL statement locks: ALTER TABLE or INDEX (and the partition it attaches or detaches, the
// parent it inherits from or stops inheriting), CREATE INDEX, TRIGGER or POLICY ON, CREATE RULE ... TO, CREATE
// STATISTICS ... FROM, the parent of CREATE TABLE ... PARTITION OF or INHERITS, the table a REFERENCES names, DROP TABLE
// or INDEX, DROP or ALTER TRIGGER, POLICY or RULE ON, REINDEX, CLUSTER and LOCK TABLE. [{ schema, name, line }]; reads, writes and
// grants are not DDL.
export function lockedTables(tokens) {
  const head = tokens[0];
  const tables = [];
  const push = (name) => name && !name.dynamic && tables.push({ schema: name.schema, name: name.name, line: name.line ?? head.line });
  const onTable = (k) => {
    const on = findWord(tokens, k, 'on');
    if (on !== -1) push(qualifiedName(tokens, skipWords(tokens, on + 1, 'only')));
  };
  const references = () => {
    for (let k = 1; k < tokens.length; k++) if (isWord(tokens[k], 'references')) push(qualifiedName(tokens, k + 1));
  };
  if (isWord(head, 'create')) {
    const k = skipWords(tokens, 1, 'or', 'replace', 'unique', 'constraint', 'unlogged');
    if (isWord(tokens[k], 'index', 'trigger', 'policy')) onTable(k + 1);
    if (isWord(tokens[k], 'rule')) push(ruleTable(tokens, k + 1));
    if (isWord(tokens[k], 'statistics')) {
      const from = findWord(tokens, k + 1, 'from');
      if (from !== -1) push(qualifiedName(tokens, from + 1));
    }
    if (isWord(tokens[k], 'table')) {
      const of = tokens.findIndex((token, j) => isWord(token, 'partition') && isWord(tokens[j + 1], 'of'));
      if (of !== -1) push(qualifiedName(tokens, of + 2));
      const inherits = findWord(tokens, k + 1, 'inherits');
      if (inherits !== -1) for (const name of nameList(tokens, inherits + 2)) push(name);
      references();
    }
  } else if (isWord(head, 'alter')) {
    if (isWord(tokens[1], 'table', 'index')) {
      push(qualifiedName(tokens, skipWords(tokens, skipIfExists(tokens, 2), 'only')));
      references();
      // ATTACH or DETACH PARTITION <child> locks the child too, and [NO] INHERIT <parent> the parent.
      let depth = 0;
      for (let j = 3; j < tokens.length; j++) {
        if (isPunct(tokens[j], '(')) depth++;
        else if (isPunct(tokens[j], ')')) depth--;
        else if (depth === 0 && isWord(tokens[j], 'attach', 'detach') && isWord(tokens[j + 1], 'partition')) push(qualifiedName(tokens, j + 2));
        else if (depth === 0 && isWord(tokens[j], 'inherit')) push(qualifiedName(tokens, j + 1));
      }
    } else if (isWord(tokens[1], 'trigger', 'policy', 'rule')) {
      onTable(2);
    }
  } else if (isWord(head, 'drop')) {
    if (isWord(tokens[1], 'table', 'index')) for (const name of nameList(tokens, skipIfExists(tokens, skipWords(tokens, 2, 'concurrently')), 'cascade', 'restrict')) push(name);
    else if (isWord(tokens[1], 'trigger', 'policy', 'rule')) onTable(2);
  } else if (isWord(head, 'reindex') && isWord(tokens[1], 'table', 'index')) {
    push(qualifiedName(tokens, skipWords(tokens, 2, 'concurrently')));
  } else if (isWord(head, 'cluster')) {
    push(qualifiedName(tokens, skipWords(tokens, 1, 'verbose')));
  } else if (isWord(head, 'lock')) {
    for (const name of nameList(tokens, skipWords(tokens, 1, 'table', 'only'), 'in', 'nowait')) push(name);
  }
  return tables;
}

// A lock_timeout value that makes the wait end, and soon: a whole number of ms (the default unit), s or min, from 1 ms
// to 1 min, as a number or a string. Anything else is refused rather than parsed: 0 and DEFAULT wait for ever, and
// PostgreSQL rounds fractions and smaller units ('0.4', '400us' are 0) and reads hex and exponents ('0x0', '0e3').
const TIMEOUT_UNIT_MS = { ms: 1, s: 1000, min: 60_000 };
const waits = (token) => {
  const value = token?.t === 'string' ? token.body : token?.t === 'other' ? token.v : undefined;
  const match = /^\s*(\d{1,9})\s*(ms|s|min)?\s*$/.exec(value ?? '');
  if (!match) return false;
  const ms = Number(match[1]) * TIMEOUT_UNIT_MS[match[2] ?? 'ms'];
  return ms >= 1 && ms <= 60_000;
};

// The PL/pgSQL statement at `at` sets a local lock_timeout that waits (waits), and nothing else:
// `PERFORM [pg_catalog.]set_config('lock_timeout', <value>, true);` or `SET LOCAL lock_timeout {= | TO} <value>;`.
// `end` is where the statement's tokens end.
function setsTimeout(tokens, at, end) {
  const shape = (from, want) => from + want.length === end && want.every((w, j) => w(tokens[from + j]));
  const word = (v) => (t) => isWord(t, v);
  const punct = (v) => (t) => isPunct(t, v);
  const name = (t) => t?.t === 'string' && t.body === 'lock_timeout';
  const call = [word('set_config'), punct('('), name, punct(','), waits, punct(','), word('true'), punct(')'), punct(';')];
  if (isWord(tokens[at], 'perform')) {
    const k = isWord(tokens[at + 1], 'pg_catalog') && isPunct(tokens[at + 2], '.') ? at + 3 : at + 1;
    return shape(k, call);
  }
  return shape(at, [word('set'), word('local'), word('lock_timeout'), (t) => isPunct(t, '=') || isWord(t, 'to'), waits, punct(';')]);
}

// Whether token k may change lock_timeout: it names the setting (a SET, RESET or set_config of it, or a string an
// EXECUTE runs), it is RESET ALL, or it is a set_config whose setting is not a string literal.
const touchesTimeout = (tokens, k) => {
  const token = tokens[k];
  if ((token.t === 'word' || token.t === 'qident') && token.v.toLowerCase() === 'lock_timeout') return true;
  if (token.t === 'string' && /lock_timeout/i.test(token.body)) return true;
  if (isWord(token, 'reset') && isWord(tokens[k + 1], 'all')) return true;
  return isWord(token, 'set_config') && !(isPunct(tokens[k + 1], '(') && tokens[k + 2]?.t === 'string' && isPunct(tokens[k + 3], ','));
};

// Whether a PL/pgSQL statement starts at token k: the token before it ends a statement, a label (>>) or opens a body.
const startsStatement = (tokens, k) => {
  const before = tokens[k - 1];
  return before === undefined || isPunct(before, ';') || isPunct(before, '>') || isWord(before, 'begin', 'then', 'else', 'loop', 'declare');
};

// The tokens of `tokens` from `at` match `shape`, where a string is a word or punctuation as written, `n` the
// counter's name and `N` a positive integer.
function matches(tokens, at, shape, counter) {
  return shape.every((want, j) => {
    const token = tokens[at + j];
    if (want === 'n') return isWord(token, counter);
    if (want === 'N') return token?.t === 'other' && /^[1-9]\d*$/.test(token.v);
    if (/^\d+$/.test(want)) return token?.t === 'other' && token.v === want;
    return /^\w+$/.test(want) ? isWord(token, want) : isPunct(token, want);
  });
}
const INCREMENT = ['n', ':', '=', 'n', '+', '1'];
const BOUNDS = [['if', 'n', '>', '=', 'N', 'then', 'raise', ';', 'end', 'if'], ['if', 'n', '>', 'N', 'then', 'raise', ';', 'end', 'if']];

// The lock-retry blocks of a PL/pgSQL body, in the shape of the plan's template (§5.5):
//   DECLARE n int := 0; ... LOOP BEGIN <set lock_timeout>; <statement>; EXIT;
//   EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; ... END; END LOOP;
// that is, a BEGIN ... EXCEPTION ... END block directly in a bare LOOP (not FOR or WHILE, which may end before
// reaching the statement), whose first handler that catches lock_not_available (no OTHERS before or in it) counts
// with a counter declared as 0 and re-raises the lock error once the count is reached. Returns, for each, the token
// indexes of its BEGIN and EXCEPTION, the statements directly in it (not in an IF, CASE, inner loop or block), where it
// sets lock_timeout (set_config('lock_timeout', ..., true) or SET LOCAL lock_timeout) and where it EXITs or RETURNs,
// so the caller can check a statement sits between them in that order.
export function retryBlocks(tokens) {
  const blocks = [];
  const stack = []; // { kind: 'block' | 'loop' | 'case' | 'if', at, exception, parent, inner, bare }
  const depth = []; // the stack depth at each token
  const popTo = (kind) => {
    const at = stack.findLastIndex((entry) => entry.kind === kind);
    if (at !== -1) stack.length = at;
  };
  for (let k = 0; k < tokens.length; k++) {
    depth[k] = stack.length;
    const token = tokens[k];
    if (token.t !== 'word') continue;
    if (token.v === 'end') {
      if (isWord(tokens[k + 1], 'if', 'loop', 'case')) {
        popTo(tokens[k + 1].v);
        depth[++k] = stack.length;
        continue;
      }
      const top = stack.pop();
      if (top?.kind !== 'block' || top.exception === -1 || top.parent?.kind !== 'loop' || !top.parent.bare) continue;
      const inner = top.inner;
      // The handler's branches: each WHEN directly in the block, its conditions up to THEN, its body up to the next.
      const whens = [];
      for (let j = top.exception + 1; j < k; j++) if (depth[j] === inner && isWord(tokens[j], 'when') && startsBranch(tokens, j)) whens.push(j);
      const branches = whens.map((w, i) => {
        const then = tokens.findIndex((t, j) => j > w && depth[j] === inner && isWord(t, 'then'));
        return { conditions: tokens.slice(w + 1, then), from: then + 1, to: whens[i + 1] ?? k };
      });
      const branch = branches.find((b) => b.conditions.some((t) => isWord(t, 'lock_not_available', 'others')));
      if (!branch || !branch.conditions.some((t) => isWord(t, 'lock_not_available')) || branch.conditions.some((t) => isWord(t, 'others'))) continue;
      const statementsAt = (from, to) => {
        const at = [];
        for (let j = from; j < to; j++) if (depth[j] === inner && startsStatement(tokens, j)) at.push(j);
        return at;
      };
      const handlerStatements = statementsAt(branch.from, branch.to);
      const counters = handlerStatements.filter((j) => tokens[j].t === 'word' && matches(tokens, j, INCREMENT, tokens[j].v)).map((j) => tokens[j].v);
      const bounded = counters.some((counter) => {
        const declared = tokens.some((t, j) => j < top.at && isWord(t, counter) && startsStatement(tokens, j) && declaredZero(tokens, j));
        return declared && handlerStatements.some((j) => BOUNDS.some((shape) => matches(tokens, j, shape, counter)));
      });
      if (!bounded) continue;
      // The statements directly in the block, each with where it ends (where the next one starts).
      const starts = statementsAt(top.at + 1, top.exception);
      const ends = new Map(starts.map((s, i) => [s, starts[i + 1] ?? top.exception]));
      // A timeout is a statement directly in the block (not in an IF or inner block, which may not run) that sets a
      // local lock_timeout that waits: one of 0 waits for ever, and one that is not local outlives the transaction
      // into the runner's session. Any other token that may change lock_timeout resets it.
      const timeouts = starts.filter((s) => setsTimeout(tokens, s, ends.get(s)));
      // An EXECUTE of anything but one string literal (format(), a variable, pieces joined with ||) may run any SET,
      // so one before the statement resets it too (the statement itself may be one: the lint reads its format string).
      const resets = [];
      const dynamic = [];
      for (let j = top.at + 1; j < top.exception; j++) {
        if (timeouts.some((s) => j >= s && j < ends.get(s))) continue;
        if (touchesTimeout(tokens, j)) resets.push(j);
        if (isWord(tokens[j], 'execute') && !(tokens[j + 1]?.t === 'string' && (isPunct(tokens[j + 2], ';') || isWord(tokens[j + 2], 'using', 'into')))) dynamic.push(j);
      }
      // An EXIT or RETURN directly in the block, with no condition: one in an IF or inner loop may not run.
      const exits = starts.filter((s) => isWord(tokens[s], 'exit', 'return') && ends.get(s) <= s + 3
        && isPunct(tokens[ends.get(s) - 1], ';') && !isWord(tokens[s + 1], 'when'));
      blocks.push({ begin: top.at, exception: top.exception, statements: new Set(starts), ends, timeouts, resets, dynamic, exits });
    } else if (token.v === 'begin') {
      stack.push({ kind: 'block', at: k, exception: -1, parent: stack.at(-1), inner: stack.length + 1 });
    } else if (token.v === 'loop') {
      stack.push({ kind: 'loop', at: k, bare: startsStatement(tokens, k) });
    } else if (token.v === 'case') {
      stack.push({ kind: 'case', at: k });
    } else if (token.v === 'if' && startsStatement(tokens, k)) {
      stack.push({ kind: 'if', at: k });
    } else if (token.v === 'exception' && isWord(tokens[k + 1], 'when') && stack.at(-1)?.kind === 'block') {
      stack.at(-1).exception = k;
    }
  }
  return blocks;
}

// A WHEN that starts a handler branch: right after EXCEPTION or after the ; that ends the previous branch's body.
const startsBranch = (tokens, k) => isWord(tokens[k - 1], 'exception') || isPunct(tokens[k - 1], ';');

// The declaration starting at `at` (DECLARE n int := 0, = 0 or DEFAULT 0) gives the variable 0.
function declaredZero(tokens, at) {
  let end = at;
  while (end < tokens.length && !isPunct(tokens[end], ';')) end++;
  const value = tokens[end - 1];
  const before = tokens[end - 2];
  return value?.t === 'other' && value.v === '0' && (isPunct(before, '=') || isWord(before, 'default'));
}

// Whether the statement at token index `at` runs inside a lock-retry block: directly in it, after it sets
// lock_timeout with nothing that may change it again before the statement or in it, before an EXIT that ends the loop
// once the statement succeeded, and before the EXCEPTION that retries it.
export function inRetryBlock(blocks, at) {
  return blocks.some((b) => {
    if (!b.statements.has(at)) return false;
    const timeout = b.timeouts.findLast((j) => j < at);
    const end = b.ends.get(at);
    return timeout !== undefined && !b.resets.some((j) => j > timeout && j < end) && !b.dynamic.some((j) => j > timeout && j < at)
      && b.exits.some((j) => j > at);
  });
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
const CONTRACT = /^--\s*crove:contract(?:\s+adr=(\S*))?(?:\s|$)/;
// Kinds a plain CREATE (no OR REPLACE, no IF NOT EXISTS) makes new in this file, so dropping or locking them later in
// the same file is neither a contract change nor DDL on a table anyone else holds.
const PLAIN_CREATE_KINDS = new Set(['table', 'view', 'materialized', 'sequence', 'type', 'domain']);

// Lints one migration. Returns [{ file, line, rule, message }], in file order. `existingFunctions` are the keys of
// functions earlier migrations created (functionsCreated): CREATE OR REPLACE keeps a function's privileges, so only a
// new function needs its REVOKE. Matching is by name, so a new overload of an existing function is not caught. Each
// cross-module waiver the lint accepts is pushed to `waivers` as { file, line, schemas, reason }.
// `breakingRules` turns on contract-header and hot-table-retry (off for the files on main before they landed, see
// BREAKING_RULES_AFTER); `adrs`, when given, are the ADR numbers (4 digits) a contract header may name.
export function lintMigration(file, sql, {
  existingFunctions = new Set(),
  waivers = /** @type {{ file: string, line: number, schemas: string[], reason: string }[]} */ ([]),
  breakingRules = true,
  adrs = /** @type {Set<string> | undefined} */ (undefined),
} = {}) {
  const findings = [];
  const module = moduleOf(file);
  const schema = module === undefined ? undefined : `crove_${module}`;
  const report = (line, rule, message) => findings.push({ file, line, rule, message });
  const droppedPolicies = new Set();
  const functions = []; // { key, line }: functions created, waiting for their REVOKE
  const revoked = []; // { key | schema, index }: REVOKE ALL ... FROM PUBLIC, in order
  const dropped = []; // { key, index }: DROP FUNCTION, PROCEDURE or ROUTINE, in order
  const createdPlain = new Set(); // "<kind>:<schema>.<name>" of tables, views, types ... a plain CREATE made new in this file
  const createdFunctions = new Map(); // key of each function this file created so far -> the argument lists it created
  const usedHeaders = new Set(); // lines of the contract headers a breaking statement used
  let order = 0;
  const comments = [];
  const waiverAt = new Map(); // line of the statement a waiver comment precedes -> { line, reason }
  const commentAt = new Map(); // line -> text of a comment alone on its line
  const collectWaivers = () => {
    for (const { line, text, alone } of comments.splice(0)) {
      const match = WAIVER.exec(text);
      if (match) waiverAt.set(line + 1, { line, reason: (match[1] ?? '').trim() });
      if (alone) commentAt.set(line, text);
    }
  };
  // The first unused contract header in the comment lines right above `line` (no blank or code line between).
  const contractHeader = (line) => {
    for (let at = line - 1; commentAt.has(at); at--) {
      const match = CONTRACT.exec(commentAt.get(at));
      if (match && !usedHeaders.has(at)) return { line: at, adr: match[1] ?? '' };
    }
    return undefined;
  };
  const checkContract = (tokens, anchorLine) => {
    const change = breakingChange(tokens);
    if (change === undefined) return;
    // Dropping a helper this file created (a one-shot backfill function, say) changes no contract. A routine is matched
    // by its argument list too: another overload of the same name is not the helper (DROP without a list names the one
    // routine of that name, which a name no earlier file created can only be this file's).
    const helper = (name) => {
      if (name.dynamic) return false;
      const key = `${name.schema ?? ''}.${name.name}`;
      if (!FUNCTION_KINDS.has(change.kind)) return createdPlain.has(`${change.kind}:${key}`);
      const created = createdFunctions.get(key);
      return created !== undefined && !existingFunctions.has(key) && (name.args === undefined || created.some((args) => args !== undefined && sameSignature(args, name.args)));
    };
    if (change.names.length > 0 && change.names.every(helper)) return;
    const line = tokens[0].line;
    const header = contractHeader(anchorLine);
    if (header === undefined) {
      report(line, 'contract-header', `${change.what} is a contract change: put \`-- crove:contract adr=<id>\` on the line before the statement, naming the ADR that records it, and merge it only once no code uses what it removes (plan §3.5)`);
      return;
    }
    usedHeaders.add(header.line);
    if (!/^\d{1,4}$/.test(header.adr)) {
      report(header.line, 'contract-header', `the contract header needs adr=<number> (the ADR that records the change), got "${header.adr}"`);
    } else if (adrs !== undefined && !adrs.has(header.adr.padStart(4, '0'))) {
      report(header.line, 'contract-header', `the contract header names ADR ${header.adr.padStart(4, '0')}, which is not in docs/adr`);
    }
  };
  const checkHot = (tokens, retry) => {
    if (retry) return;
    const hot = lockedTables(tokens).filter((t) => isHotTable(t) && !createdPlain.has(`table:${t.schema}.${t.name}`));
    if (hot.length === 0) return;
    const names = [...new Set(hot.map((t) => `${t.schema}.${t.name}`))].join(', ');
    report(tokens[0].line, 'hot-table-retry', `DDL on the hot table ${names} runs in the lock-retry block (plan §5.5): DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN PERFORM set_config('lock_timeout', '2s', true); <statement>; EXIT; EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random()); END; END LOOP; END $$;`);
  };
  const noteCreated = (tokens) => {
    if (!isWord(tokens[0], 'create')) return;
    const replace = isWord(tokens[1], 'or');
    let k = skipWords(tokens, 1, 'or', 'replace', 'unlogged');
    if (isWord(tokens[k], 'function', 'procedure', 'aggregate')) {
      const name = qualifiedName(tokens, k + 1);
      if (name && !name.dynamic) {
        const key = `${name.schema ?? ''}.${name.name}`;
        createdFunctions.set(key, [...(createdFunctions.get(key) ?? []), signature(tokens, name.end)]);
      }
      return;
    }
    if (replace || !isWord(tokens[k]) || !PLAIN_CREATE_KINDS.has(tokens[k].v)) return;
    const kind = tokens[k].v;
    k += isWord(tokens[k], 'materialized') ? 2 : 1;
    if (isWord(tokens[k], 'if')) return;
    const name = qualifiedName(tokens, k);
    if (name && !name.dynamic) createdPlain.add(`${kind}:${name.schema ?? ''}.${name.name}`);
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

  // `ctx.retry(head)` says whether the statement runs in a lock-retry block; `ctx.anchorLine` is the line of the
  // EXECUTE whose command string holds the statement, where its contract header goes.
  const TOP = { retry: () => false, anchorLine: undefined };
  const lintStatement = (raw, nested, ctx = TOP) => {
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
        report(head.line, 'policy-drop-first', `CREATE POLICY ${key} needs DROP POLICY IF EXISTS ${key} before it, so the file can be re-applied`);
      }
    }

    if (isWord(head, 'create')) {
      const k = skipWords(tokens, 1, 'or', 'replace');
      if (isWord(tokens[k], 'function', 'procedure')) {
        const name = qualifiedName(tokens, k + 1);
        if (name) functions.push({ key: `${name.schema ?? ''}.${name.name}`, schema: name.schema, label: name.schema ? `${name.schema}.${name.name}` : name.name, line: head.line, index: order });
      }
    }
    if (isWord(head, 'drop') && isWord(tokens[1], 'function', 'procedure', 'routine')) {
      for (const name of nameList(tokens, skipIfExists(tokens, 2), 'cascade', 'restrict')) dropped.push({ key: `${name.schema ?? ''}.${name.name}`, index: order });
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
    // A waiver covers only the first statement that starts on the line after it.
    const waiver = waiverAt.get(head.line);
    waiverAt.delete(head.line);
    const waived = new Set();
    for (const object of objects) if (!object.dynamic) checkSchema(object.schema, object.line, object.name, waiver, waived);
    for (const named of schemas) if (!named.schema?.startsWith('%')) checkSchema(named.schema, named.line, named.what ?? 'the schema', waiver, waived);
    if (waived.size > 0) waivers.push({ file, line: head.line, schemas: [...waived].sort(), reason: waiver.reason });

    if (breakingRules) {
      checkContract(tokens, ctx.anchorLine ?? head.line);
      checkHot(tokens, ctx.retry(head));
    }
    // Only a top-level CREATE surely ran: one in a DO may sit in a branch not taken or a block that swallows its error.
    if (ctx === TOP && !nested) noteCreated(tokens);

    // DO bodies, and SQL an EXECUTE runs from a string literal.
    if (isWord(head, 'do')) {
      // DO [LANGUAGE lang] code, or DO code LANGUAGE lang: the code is the string that does not name the language.
      const body = tokens.find((token, k) => token.t === 'string' && !isWord(tokens[k - 1], 'language'));
      if (body) {
        const bodyTokens = lex(body.body, body.bodyLine, comments, true);
        const blocks = retryBlocks(bodyTokens);
        const index = new Map(bodyTokens.map((token, k) => [token, k]));
        const inherited = ctx.retry(head);
        collectWaivers();
        const inner = { retry: (h) => inherited || inRetryBlock(blocks, index.get(h) ?? -1), anchorLine: undefined };
        for (const statement of splitStatements(bodyTokens)) lintStatement(statement, true, inner);
      }
    } else if (nested && isWord(head, 'execute')) {
      // Only the command string (EXECUTE '...' or the format string of EXECUTE format('...', ...)): later strings are
      // arguments or USING values, which may read as a command word ('delete') without being one. The command string
      // may hold several statements, each linted.
      const using = findWord(tokens, 1, 'using');
      const command = tokens.slice(0, using === -1 ? tokens.length : using).find((token) => token.t === 'string');
      const inner = { retry: ctx.retry(head) ? () => true : () => false, anchorLine: ctx.anchorLine ?? head.line };
      if (command !== undefined) for (const statement of splitStatements(lex(command.body, command.bodyLine))) lintStatement(statement, false, inner);
    }
  };

  const statements = splitStatements(lex(sql, 1, comments));
  collectWaivers();
  for (const statement of statements) lintStatement(statement, false);

  for (const fn of functions) {
    // A function dropped earlier in this file and created again is new: the drop took its privileges with it.
    const recreated = dropped.some((d) => d.key === fn.key && d.index < fn.index);
    if (existingFunctions.has(fn.key) && !recreated) continue;
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

// The ADR numbers in docs/adr: the 4-digit prefix of each NNNN-<title>.md.
export function adrNumbers(names) {
  return new Set(names.map((name) => /^(\d{4})-.+\.md$/.exec(name)?.[1]).filter((n) => n !== undefined));
}

// Whether contract-header and hot-table-retry apply to a migration: always for a file a PR adds (`added`, from
// --since), otherwise for a version above BREAKING_RULES_AFTER.
export function breakingRulesApply(name, added) {
  return added || basename(name).slice(0, 14) > BREAKING_RULES_AFTER;
}

// The migration files to lint and, for each, the functions the migrations before it created.
export function plan(allNames, selected, allowlist) {
  const sorted = [...allNames].filter((name) => name.endsWith('.sql')).sort();
  const wanted = new Set(selected ?? sorted);
  return sorted.filter((name) => wanted.has(name) && !allowlist.has(name));
}

// From `git diff --name-status --no-renames <since> HEAD`: the migration files added (names), and a finding for each
// one changed or deleted. A file that exists at <since> is on the base, so it may already be applied: AGENTS.md never
// edits an applied file, and a fresh install would apply the edited content while migrated databases keep the old.
export function changedMigrations(nameStatus) {
  const added = [];
  const edited = [];
  for (const row of nameStatus.split('\n').filter(Boolean)) {
    const [status, path] = row.split('\t');
    if (!path?.endsWith('.sql')) continue;
    if (status === 'A') added.push(basename(path));
    else edited.push({ file: path, line: 1, rule: 'no-edit-applied', message: `${status === 'D' ? 'deletes' : 'changes'} a migration that is already on the base branch; never edit or delete an applied migration, add a new one` });
  }
  return { added, edited };
}

function main() {
  const args = process.argv.slice(2);
  const ref = option(args, '--allowlist-ref');
  const since = option(args, '--since');
  const allowlist = readAllowlist(ref);
  const all = readdirSync(DIR);
  const changes = since === undefined ? undefined : changedMigrations(
    execFileSync('git', ['diff', '--name-status', '--no-renames', since, 'HEAD', '--', DIR], { encoding: 'utf8' }),
  );
  const selected = changes !== undefined ? changes.added : args.length > 0 ? args.map((path) => basename(path)) : undefined;
  const names = plan(all, selected, allowlist);
  const existing = new Map(); // name -> the functions every earlier file created
  const known = new Set();
  for (const name of [...all].filter((n) => n.endsWith('.sql')).sort()) {
    existing.set(name, new Set(known));
    for (const key of functionsCreated(readFileSync(DIR + name, 'utf8'))) known.add(key);
  }
  const files = names.map((name) => DIR + name);
  const waivers = [];
  const adrs = adrNumbers(readdirSync(ADR_DIR));
  const findings = names.flatMap((name) => lintMigration(DIR + name, readFileSync(DIR + name, 'utf8'), {
    existingFunctions: existing.get(name),
    waivers,
    adrs,
    breakingRules: breakingRulesApply(name, changes !== undefined),
  }));
  findings.push(...(changes?.edited ?? []));
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
