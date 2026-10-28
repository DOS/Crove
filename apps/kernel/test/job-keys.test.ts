// Every pg-boss key is <org_id>:<job>:<key>, built by apps/kernel/src/job-keys.ts (plan §4.8 "Job keys", #1694).
// The kernel's sources are parsed: a singletonKey or a group in apps/kernel/src, and the key argument of
// sendThrottled() and sendDebounced(), must be a call of the helper (a condition between two calls of it aside),
// imported from job-keys.ts. Where a send's options and data are written inline, its key also names the queue it is
// sent to and the org of its data (data.orgId); options or data built elsewhere are checked for the helper only.
// Planted sources show each check failing.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseAst } from 'vitest/node';
import { describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, jobGroup, jobKey, systemJobKey } from '../src/job-keys.ts';
import { MAIL_QUEUES, QUEUES, SOCIAL_PUBLISH_QUEUES } from '../src/jobs-schema.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const SRC = 'apps/kernel/src';

// An ESTree node.
type N = { type: string; start: number; end: number; [key: string]: any };

const children = (node: N): N[] =>
  Object.values(node).flatMap((v) => (Array.isArray(v) ? v.filter((c): c is N => typeof c?.type === 'string') : typeof v?.type === 'string' ? [v as N] : []));
function each(node: N, fn: (n: N) => void): void {
  fn(node);
  for (const child of children(node)) each(child, fn);
}

// The helpers, by the option they build.
const BUILDERS: Readonly<Record<string, readonly string[]>> = { singletonKey: ['jobKey', 'systemJobKey'], group: ['jobGroup'] };
const HELPERS = new Set(Object.values(BUILDERS).flat());
const HELPER_FILE = /^\.\.?\/(?:[\w.-]+\/)*job-keys(\.ts)?$/;
// pg-boss sends whose fifth argument is the singleton key.
const POSITIONAL = new Set(['sendThrottled', 'sendDebounced']);

const nameOf = (key: N): string | null => (key.type === 'Identifier' ? key.name : key.type === 'Literal' && typeof key.value === 'string' ? key.value : null);

// The helper calls an option's value is made of: the call itself, or each side of a condition. null when it is anything
// else (a template string, a variable, a field of the job, another function).
function builtBy(value: N, helpers: readonly string[]): N[] | null {
  if (value.type === 'CallExpression' && value.callee.type === 'Identifier' && helpers.includes(value.callee.name)) return [value];
  if (value.type === 'ConditionalExpression') {
    const a = builtBy(value.consequent, helpers);
    const b = builtBy(value.alternate, helpers);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

// The job a helper call names: the second argument of jobKey and jobGroup, the first of systemJobKey.
const jobArg = (call: N): N | undefined => call.arguments[call.callee.name === 'systemJobKey' ? 0 : 1];

interface Scan {
  problems: string[];
  // How many singletonKey and group options were found built by the helper.
  keys: number;
  groups: number;
}

/** The raw keys of the sources: path -> text. */
export function scan(files: Readonly<Record<string, string>>): Scan {
  const out: Scan = { problems: [], keys: 0, groups: 0 };
  for (const [file, text] of Object.entries(files)) {
    const program = parseAst(text, { lang: 'ts' } as never) as unknown as N;
    const lineOf = (node: N) => text.slice(0, node.start).split('\n').length;
    const at = (node: N) => `${file}:${lineOf(node)}`;
    const source = (node: N) => text.slice(node.start, node.end);
    // The helpers this file imports from job-keys.ts under their own names, and the names it declares itself.
    const imported = new Set<string>();
    const declared = new Set<string>();
    each(program, (node) => {
      if (node.type === 'ImportDeclaration' && HELPER_FILE.test(String(node.source.value))) {
        for (const spec of node.specifiers as N[]) if (spec.type === 'ImportSpecifier' && nameOf(spec.imported) === spec.local.name) imported.add(spec.local.name);
      }
      if ((node.type === 'FunctionDeclaration' || node.type === 'VariableDeclarator') && node.id?.type === 'Identifier' && HELPERS.has(node.id.name)) declared.add(node.id.name);
    });
    for (const name of declared) out.problems.push(`${file}: declares its own ${name}; build job keys with the one of job-keys.ts`);
    // Destructuring reads an option, it does not set one.
    const read = new Set<N>();
    each(program, (node) => {
      if (node.type === 'ObjectPattern') for (const prop of node.properties as N[]) read.add(prop);
    });
    const helperCalls = (value: N, name: string, where: N): N[] | null => {
      const helpers = BUILDERS[name] as readonly string[];
      const calls = builtBy(value, helpers);
      if (!calls) {
        out.problems.push(`${at(where)}: ${name} ${source(value).slice(0, 60)} is not built by ${helpers.join(' or ')}() of job-keys.ts`);
        return null;
      }
      for (const call of calls) {
        if (!imported.has(call.callee.name)) out.problems.push(`${at(call)}: ${call.callee.name}() is not the one of job-keys.ts`);
      }
      if (name === 'singletonKey') out.keys += 1;
      else out.groups += 1;
      return calls;
    };

    each(program, (node) => {
      // An option set after the object is made.
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
        const name = node.left.computed ? nameOf(node.left.property) : node.left.property.name;
        if (name && Object.hasOwn(BUILDERS, name)) out.problems.push(`${at(node)}: ${name} assigned; set it in the options object with ${BUILDERS[name]?.join(' or ')}()`);
        return;
      }
      if (node.type !== 'Property' || read.has(node)) return;
      const name = node.computed ? (node.key.type === 'Literal' ? nameOf(node.key) : null) : nameOf(node.key);
      if (!name || !Object.hasOwn(BUILDERS, name)) return;
      if (node.shorthand) {
        out.problems.push(`${at(node)}: ${name} ${source(node.value).slice(0, 60)} is not built by ${(BUILDERS[name] as readonly string[]).join(' or ')}() of job-keys.ts`);
        return;
      }
      helperCalls(node.value, name, node);
    });

    // A send's key names the queue it is sent to and the org of its data:
    // boss.send(queue, { orgId: org, .. }, { singletonKey: jobKey(org, queue, ..) }).
    each(program, (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
      const method = node.callee.computed ? nameOf(node.callee.property) : node.callee.property.name;
      if (method !== 'send' && !(method && POSITIONAL.has(method))) return;
      const [queue, data, options] = node.arguments as N[];
      if (!queue) return;
      const built: Array<[string, N]> = [];
      if (options?.type === 'ObjectExpression') {
        for (const prop of options.properties as N[]) {
          if (prop.type !== 'Property' || prop.shorthand) continue;
          const name = nameOf(prop.key);
          if (!name || !Object.hasOwn(BUILDERS, name)) continue;
          for (const call of builtBy(prop.value, BUILDERS[name] as readonly string[]) ?? []) built.push([name, call]);
        }
      }
      // sendThrottled(name, data, options, seconds, key) and sendDebounced(...) take the key as an argument.
      const positional = method !== 'send' ? (node.arguments as N[])[4] : undefined;
      if (positional) for (const call of helperCalls(positional, 'singletonKey', positional) ?? []) built.push(['singletonKey', call]);
      const orgOfData =
        data?.type === 'ObjectExpression' ? ((data.properties as N[]).find((p) => p.type === 'Property' && !p.computed && nameOf(p.key) === 'orgId')?.value as N | undefined) : undefined;
      for (const [name, call] of built) {
        const job = jobArg(call);
        if (!job || source(job) !== source(queue)) out.problems.push(`${at(call)}: ${name} names job ${job ? source(job) : 'none'} but is sent to ${source(queue)}`);
        if (!orgOfData) continue;
        if (call.callee.name === 'systemJobKey') out.problems.push(`${at(call)}: ${name} of a job of org ${source(orgOfData)} is built by systemJobKey()`);
        else if (!call.arguments[0] || source(call.arguments[0]) !== source(orgOfData)) {
          out.problems.push(`${at(call)}: ${name} names org ${call.arguments[0] ? source(call.arguments[0]) : 'none'} but the job's org is ${source(orgOfData)}`);
        }
      }
    });
  }
  return out;
}

function kernelSources(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      // The helper itself aside.
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && path !== `${SRC}/job-keys.ts`) out[path] = readFileSync(join(ROOT, path), 'utf8');
    }
  };
  walk(SRC);
  return out;
}

const HEAD = "import { jobGroup, jobKey, systemJobKey } from './job-keys.ts';\n";
const planted = (body: string) => ({ [`${SRC}/planted.ts`]: HEAD + body });

describe('every pg-boss key of the kernel is built by job-keys.ts (#1694)', () => {
  it('finds no raw key in apps/kernel/src', () => {
    const sources = kernelSources();
    const found = scan(sources);
    expect(found.problems).toEqual([]);
    // The scan sees the worker's keys, so a parser that found nothing could not pass it.
    expect(found.keys).toBeGreaterThanOrEqual(30);
    expect(found.groups).toBeGreaterThanOrEqual(2);
    expect(Object.keys(sources)).toContain(`${SRC}/mail-queue.ts`);
  });

  it('fails once a raw key is planted in the real sources', () => {
    const sources = kernelSources();
    const mail = sources[`${SRC}/mail-queue.ts`] as string;
    const built = 'singletonKey: jobKey(row.org_id, queue, row.message_id)';
    expect(mail).toContain(built);
    const found = scan({ ...sources, [`${SRC}/mail-queue.ts`]: mail.replace(built, 'singletonKey: row.message_id') });
    expect(found.problems).toEqual([expect.stringMatching(/^apps\/kernel\/src\/mail-queue\.ts:\d+: singletonKey row\.message_id is not built by jobKey or systemJobKey\(\) of job-keys\.ts$/)]);
  });

  it.each([
    ['a raw id', "boss.send(q, data, { singletonKey: row.message_id });"],
    ['an org-prefixed template string', 'boss.send(q, data, { singletonKey: `${row.org_id}:${row.event_id}` });'],
    ['a variable', 'const singletonKey = jobKey(org, q, k);\nboss.send(q, data, { singletonKey });'],
    ['a raw group', 'const options = { group: { id: row.org_id } };'],
    ['a key on one side of a condition only', "boss.send(q, data, { singletonKey: test ? jobKey(org, q, 'test') : row.event_id });"],
    ['a key set after the object', 'options.singletonKey = row.blob_id;'],
    ["a computed option name", "boss.send(q, data, { ['singletonKey']: row.blob_id });"],
    ['a raw throttle key', 'boss.sendThrottled(q, data, {}, 60, row.message_id);'],
    ['a raw debounce key', 'boss.sendDebounced(q, data, { retryLimit: 0 }, 60, `${org}:x`);'],
  ])('fails on %s', (_, body) => {
    expect(scan(planted(body)).problems).toHaveLength(1);
  });

  it('fails on a helper that is not the one of job-keys.ts', () => {
    const own = { [`${SRC}/planted.ts`]: "const jobKey = (o: string, j: string, k: string) => k;\nboss.send(q, data, { singletonKey: jobKey(org, q, k) });" };
    expect(scan(own).problems).toEqual([
      `${SRC}/planted.ts: declares its own jobKey; build job keys with the one of job-keys.ts`,
      `${SRC}/planted.ts:2: jobKey() is not the one of job-keys.ts`,
    ]);
    const renamed = { [`${SRC}/planted.ts`]: "import { systemJobKey as jobKey } from './job-keys.ts';\nboss.send(q, data, { singletonKey: jobKey(q, k) });" };
    expect(scan(renamed).problems).toContain(`${SRC}/planted.ts:2: jobKey() is not the one of job-keys.ts`);
  });

  it("fails on a key that names another queue than the send's", () => {
    expect(scan(planted('boss.send(QUEUES.notify, data, { singletonKey: jobKey(row.org_id, QUEUES.socialNotify, row.event_id) });')).problems).toEqual([
      `${SRC}/planted.ts:2: singletonKey names job QUEUES.socialNotify but is sent to QUEUES.notify`,
    ]);
    expect(scan(planted('boss.send(QUEUES.inbound, data, { singletonKey: systemJobKey(QUEUES.mailEvent, id) });')).problems).toHaveLength(1);
  });

  it("fails on a key that names another org than the job's", () => {
    expect(scan(planted('boss.send(q, { orgId: row.org_id, agentId }, { singletonKey: jobKey(agentId, q, k) });')).problems).toEqual([
      `${SRC}/planted.ts:2: singletonKey names org agentId but the job's org is row.org_id`,
    ]);
    expect(scan(planted("boss.send(q, { orgId }, { singletonKey: jobKey('0198e1f2-3a4b-7c5d-8e6f-a1b2c3d4e5f6', q, k) });")).problems).toHaveLength(1);
    expect(scan(planted('boss.send(q, { orgId: row.org_id }, { group: jobGroup(other, q) });')).problems).toHaveLength(1);
    expect(scan(planted('boss.send(q, { orgId: row.org_id }, { singletonKey: systemJobKey(q, k) });')).problems).toEqual([
      `${SRC}/planted.ts:2: singletonKey of a job of org row.org_id is built by systemJobKey()`,
    ]);
    expect(scan(planted('boss.sendThrottled(q, { orgId: row.org_id }, {}, 60, jobKey(row.event_id, q, k));')).problems).toHaveLength(1);
  });

  it('reads destructured options and helpers imported from another directory as fine', () => {
    const body = "import { jobKey } from '../job-keys.ts';\nconst { singletonKey, group } = job;\nboss.sendThrottled(q, { orgId }, {}, 60, jobKey(orgId, q, id));";
    expect(scan({ [`${SRC}/sub/planted.ts`]: body })).toEqual({ problems: [], keys: 1, groups: 0 });
  });

  it('passes keys and groups built by the helper', () => {
    const body = [
      'boss.send(QUEUES.notify, { orgId: row.org_id }, { singletonKey: jobKey(row.org_id, QUEUES.notify, row.event_id), group: jobGroup(row.org_id, QUEUES.notify) });',
      "boss.send(q, data, { singletonKey: test ? jobKey(org, q, 'test') : jobKey(org, q, id) });",
      'boss.send(QUEUES.inbound, data, { singletonKey: systemJobKey(QUEUES.inbound, row.blob_id) });',
      'const options = { group: jobGroup(org, QUEUES.extract) };',
    ].join('\n');
    expect(scan(planted(body))).toEqual({ problems: [], keys: 3, groups: 2 });
  });
});

describe('job keys', () => {
  const orgA = '0198e1f2-3a4b-7c5d-8e6f-a1b2c3d4e5f6';
  const orgB = '0198e1f2-3a4b-7c5d-8e6f-a1b2c3d4e5f7';
  const queues = [...Object.values(QUEUES), ...SOCIAL_PUBLISH_QUEUES, ...MAIL_QUEUES];

  it('builds <org_id>:<job>:<key>', () => {
    expect(jobKey(orgA, QUEUES.agentWake, 'agent-1')).toBe(`${orgA}:kernel-agent-wake:agent-1`);
    expect(jobKey(orgA.toUpperCase(), QUEUES.agentWake, 'agent-1')).toBe(`${orgA}:kernel-agent-wake:agent-1`);
    expect(systemJobKey(QUEUES.inbound, 'blob-1')).toBe('system:kernel-inbound-email:blob-1');
    expect(jobGroup(orgA, QUEUES.extract)).toEqual({ id: `${orgA}:finance-file-extract:org` });
  });

  it('accepts every queue name as a job', () => {
    for (const queue of queues) expect(jobKey(orgA, queue, 'k')).toBe(`${orgA}:${queue}:k`);
  });

  it('never gives two orgs, or an org and the system, the same key, whatever keys they pass', () => {
    // Keys chosen to collide if the parts ran together: colons, the other org's id, the job name, the scope.
    const keys = ['', 'k', ':', 'k:', ':k', `${orgB}:k`, `${orgA}`, `${QUEUES.notify}:k`, `k:${orgB}`, SYSTEM_SCOPE, `${SYSTEM_SCOPE}:k`];
    const built = new Map<string, string>();
    for (const job of [QUEUES.notify, QUEUES.socialNotify, MAIL_QUEUES[0] as string])
      for (const key of keys) {
        for (const [owner, value] of [
          [`${orgA}|${job}|${key}`, jobKey(orgA, job, key)],
          [`${orgB}|${job}|${key}`, jobKey(orgB, job, key)],
          [`system|${job}|${key}`, systemJobKey(job, key)],
          [`group ${orgA}|${job}`, jobGroup(orgA, job).id],
          [`group ${orgB}|${job}`, jobGroup(orgB, job).id],
        ] as const) {
          const before = built.get(value);
          if (before !== undefined && before !== owner) throw new Error(`${owner} and ${before} share ${value}`);
          built.set(value, owner);
        }
      }
    expect(built.size).toBe(3 * keys.length * 3 + 3 * 2);
  });

  it('refuses an org that is not a UUID and a job that is not a queue name', () => {
    // An org id with a colon could pass for another org's id followed by part of the key.
    expect(() => jobKey(`${orgA}:x`, QUEUES.notify, 'k')).toThrow('the org must be a UUID');
    expect(() => jobKey('o-1', QUEUES.notify, 'k')).toThrow('the org must be a UUID');
    expect(() => jobKey(SYSTEM_SCOPE, QUEUES.notify, 'k')).toThrow('the org must be a UUID');
    expect(() => jobGroup('', QUEUES.extract)).toThrow('the org must be a UUID');
    expect(() => jobKey(orgA, `${QUEUES.notify}:x`, 'k')).toThrow('the job must be a queue name');
    expect(() => systemJobKey('', 'k')).toThrow('the job must be a queue name');
  });
});
