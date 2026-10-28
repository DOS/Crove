// Invariant suite (Decision 7): what commands declare they write (CommandDef.writes, plan §4.7 "Derived risk", #1697,
// #1710). P04 flags an agent's proposal of a command that writes a `contact` or `payment` column, refuses agent access
// to such a command, and lets agents approve only proposals of commands declared free of them. Those answers rest on
// the declared writes and on the manifests' column classes, so this file holds both: the runtime, given the
// manifests, refuses a declaration whose classes are not its manifest's (a hand-built map, a '*' column); the server
// builds its one runtime with the manifests, which are frozen; every command the server registers declares writes
// that match the manifests, every command an agent may run declares its writes (the runtime refuses one that does
// not) and none is a contact or payment column; no proposal command escapes P04 unless it is listed here; and no
// contact or payment column of the manifests is reclassified away. No database needed. Keep this file
// self-contained: import package code under test, never helpers from outside test/invariant/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CellResolver } from '@crove/db';
import { kernelManifest } from '@crove/kernel';
import { DATA_CLASSES, tableWrite } from '@crove/kernel-contract';
import { Runtime, WRITE_DATA_CLASSES, defineCommand, type AgentApprovers, type CommandDef, type CommandWrite, type ManifestTables } from '@crove/kernel-runtime';
import { financeManifest } from '@crove/mod-finance';
import { loadConfig } from '../../src/config.ts';
import { moduleDefinitions, moduleManifests, serverRuntime } from '../../src/kernel.ts';
import { orgPurgeCommand } from '../../src/org-purge.ts';

const noDatabase = (): never => {
  throw new Error('no database in this test');
};
const cells: CellResolver = { resolveTenant: async () => noDatabase(), controlPlane: () => noDatabase() };

// Every module on, as the server runs when CROVE_MODULES is unset.
const CONFIG_ENV = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };
const config = loadConfig(CONFIG_ENV);
const manifests = (): ManifestTables[] => moduleManifests(config).map((m) => m.tables);
const shipped = (): Array<CommandDef<unknown, unknown>> =>
  [...moduleDefinitions(config).commands, orgPurgeCommand({ store: {} as never })] as Array<CommandDef<unknown, unknown>>;

// Proposal commands an agent's proposal of which is not flagged P04: their declared writes name no contact or payment
// column. None yet. Adding one is a review of its declaration and of the handlers of the events it emits (#1710): land
// the name here first, then the declaration.
const PROPOSALS_WITHOUT_P04: readonly string[] = [];

// The contact and payment columns of the manifests (plan §4.7, §5.2). A manifest may add more; reclassifying one of
// these, or dropping it while its table stays, would take P04 off every command that writes it.
const P04_COLUMNS: Readonly<Record<string, 'contact' | 'payment'>> = {
  'crove_kernel.inbound_message.from_address': 'contact',
  'crove_kernel.mail_message.to_address': 'contact',
  'crove_kernel.member_invite.email': 'contact',
  'crove_kernel.party.address': 'contact',
  'crove_kernel.party.email': 'contact',
  'crove_kernel.party.phone': 'contact',
  'crove_kernel.tenant.address': 'contact',
  'crove_kernel.tenant.contact_email': 'contact',
  'crove_finance.bank_line.bank_account': 'payment',
  'crove_social.report_schedule.recipients': 'contact',
  'crove_crm.booking.email': 'contact',
  'crove_crm.booking.phone': 'contact',
};

const PARTY = kernelManifest.tables.crove_kernel.party;
const CONTACT = tableWrite(kernelManifest.tables, 'crove_kernel', 'party', ['email']);
const PAYMENT = tableWrite(financeManifest.tables, 'crove_finance', 'bank_line', ['bank_account']);
const INTERNAL = tableWrite(kernelManifest.tables, 'crove_kernel', 'task_comment', ['body']);

const def = (extra: Partial<CommandDef<unknown, unknown>>): CommandDef<unknown, unknown> =>
  defineCommand({ name: 't1710.reg', input: z.object({}), risk: 'R1', access: 'proposal', handler: async () => ({}), ...extra }) as CommandDef<unknown, unknown>;
const withManifests = (extra: Partial<CommandDef<unknown, unknown>>) => () => new Runtime(cells, { manifests: manifests() }).register({ commands: [def(extra)] });
const withoutManifests = (extra: Partial<CommandDef<unknown, unknown>>) => () => new Runtime(cells).register({ commands: [def(extra)] });
const forged = (classes: Record<string, string>, columns: readonly string[] = ['email']): CommandWrite => ({ table: 'crove_kernel.party', classes, columns });

describe('declared command writes against the manifests (#1697, #1710)', () => {
  it('knows the data classes the manifests use', () => {
    expect([...WRITE_DATA_CLASSES]).toEqual([...DATA_CLASSES]);
  });

  it('refuses, given the manifests, a declaration whose classes are not its manifest', () => {
    // The contact column passed off as internal, so the command would look free of P04.
    expect(withManifests({ writes: [forged({ ...PARTY, email: 'internal' })], agentApprovers: { roles: ['finance.chief_accountant'] } })).toThrow(
      /not its manifest's/,
    );
    expect(withManifests({ access: [], agent: { roles: 'any' }, writes: [forged({ ...PARTY, email: 'internal' })] })).toThrow(/not its manifest's/);
    // Only the columns it writes, a column the table does not have, or one left out.
    expect(withManifests({ writes: [forged({ email: 'internal' })] })).toThrow(/not its manifest's/);
    expect(withManifests({ writes: [forged({ ...PARTY, nickname: 'internal' })] })).toThrow(/not its manifest's/);
    const { email: _email, ...withoutEmail } = PARTY;
    expect(withManifests({ writes: [forged(withoutEmail, ['name'])] })).toThrow(/not its manifest's/);
    // A table no manifest has.
    expect(withManifests({ writes: [{ table: 'crove_kernel.no_such_table', classes: { body: 'internal' }, columns: ['body'] }] })).toThrow(/no module manifest has/);
    // What the manifests give passes, and P04 follows their classes.
    expect(withManifests({ writes: [CONTACT, PAYMENT, INTERNAL] })).not.toThrow();
    const runtime = new Runtime(cells, { manifests: manifests() }).register({
      commands: [def({ name: 't1710.contact', writes: [INTERNAL, CONTACT] }), def({ name: 't1710.clean', writes: [INTERNAL] })],
    });
    expect(runtime.commandInfo('t1710.contact')?.contactOrPayment).toBe(true);
    expect(runtime.commandInfo('t1710.clean')?.contactOrPayment).toBe(false);
  });

  it('refuses a pattern for a column, with or without the manifests', () => {
    for (const register of [withManifests, withoutManifests]) {
      expect(register({ writes: [forged({ '*': 'internal' }, ['*'])] })).toThrow(/not a column name/);
      expect(register({ writes: [forged({ ...PARTY, '*': 'internal' })] })).toThrow(/not a column name/);
    }
  });

  it('reads the classes once, so a getter cannot answer the checks one class and P04 another', () => {
    for (const options of [{ manifests: manifests() }, {}]) {
      let reads = 0;
      const classes = { ...PARTY };
      Object.defineProperty(classes, 'email', { enumerable: true, get: () => (reads++ === 0 ? 'contact' : 'internal') });
      const runtime = new Runtime(cells, options).register({ commands: [def({ writes: [forged(classes)] })] });
      expect(runtime.commandInfo('t1710.reg')?.contactOrPayment).toBe(true);
    }
  });

  it('refuses manifests that give one table twice', () => {
    expect(() => new Runtime(cells, { manifests: [kernelManifest.tables, kernelManifest.tables] })).toThrow(/in two manifests/);
    expect(() => new Runtime(cells, { manifests: [{ crove_kernel: { party: { email: 'secret' } } }] })).toThrow(/unknown class/);
  });

  it('gives the server every enabled module its own manifest', () => {
    expect(config.CROVE_MODULES.length).toBeGreaterThan(1);
    expect(moduleManifests(config).map((m) => m.id)).toEqual([...config.CROVE_MODULES]);
  });

  it('builds the server runtime with the manifests, for every set of enabled modules', () => {
    const forgedCommand = def({ name: 'kernel.t1710_forged', writes: [forged({ ...PARTY, email: 'internal' })] });
    for (const modules of [undefined, 'finance', 'crm', 'notes', 'social']) {
      const runtime = serverRuntime(cells, loadConfig({ ...CONFIG_ENV, ...(modules ? { CROVE_MODULES: modules } : {}) }), {});
      // Registered on it later, as createKernel registers the org purge, a forged write is refused too.
      expect(() => runtime.register({ commands: [forgedCommand] }), String(modules)).toThrow(/not its manifest's/);
    }
  });

  it('constructs a runtime in the server only through serverRuntime()', () => {
    const src = fileURLToPath(new URL('../../src/', import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
      });
    const sites = files(src).flatMap((file) => (readFileSync(file, 'utf8').match(/new\s+Runtime\b/g) ?? []).map(() => relative(src, file).split(sep).join('/')));
    expect(sites).toEqual(['kernel.ts']);
    const kernel = readFileSync(join(src, 'kernel.ts'), 'utf8');
    const body = kernel.slice(kernel.indexOf('export function serverRuntime('));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/new\s+Runtime\b/);
  });

  it('freezes every manifest, and the runtime keeps its own copy of the classes', () => {
    const unfrozen: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value !== 'object' || value === null) return;
      if (!Object.isFrozen(value)) unfrozen.push(path);
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    };
    for (const manifest of moduleManifests(config)) walk(manifest, manifest.id);
    expect(unfrozen).toEqual([]);
    expect(() => {
      (kernelManifest.tables.crove_kernel as Record<string, unknown>).party = { email: 'internal' };
    }).toThrow(TypeError);
    // A manifest object changed after the runtime read it does not change the check.
    const tables = { crove_kernel: { party: { ...PARTY } } };
    const runtime = new Runtime(cells, { manifests: [tables] });
    tables.crove_kernel.party.email = 'internal';
    expect(() => runtime.register({ commands: [def({ writes: [forged({ ...PARTY, email: 'internal' })] })] })).toThrow(/not its manifest's/);
  });

  it('refuses a command an agent may run that does not declare its writes, and the old noContactOrPayment form', () => {
    for (const register of [withManifests, withoutManifests]) {
      expect(register({ access: [], agent: { roles: 'any' } })).toThrow(/an agent may run it, so it declares its writes/);
      expect(register({ access: [], agent: { roles: 'any' }, writes: [] })).not.toThrow();
      expect(register({ agentApprovers: { roles: ['finance.chief_accountant'] } })).toThrow(/declares its writes/);
      expect(register({ agentApprovers: { roles: ['finance.chief_accountant'], noContactOrPayment: true } as AgentApprovers })).toThrow(/declares its writes/);
      expect(register({ agentApprovers: { roles: ['finance.chief_accountant'], noContactOrPayment: true } as AgentApprovers, writes: [INTERNAL] })).toThrow(
        /no longer take noContactOrPayment/,
      );
    }
  });

  it('registers every command the server ships against the manifests', () => {
    const commands = shipped();
    expect(() => new Runtime(cells, { manifests: manifests() }).register({ commands })).not.toThrow();
  });

  it('declares the writes of every command an agent may run, none of them a contact or payment column', () => {
    const commands = shipped();
    const runtime = new Runtime(cells, { manifests: manifests() }).register({ commands });
    const agentCommands = commands.filter((c) => c.agent !== undefined);
    expect(agentCommands.length).toBeGreaterThan(0);
    expect(agentCommands.filter((c) => c.writes === undefined).map((c) => c.name)).toEqual([]);
    expect(agentCommands.filter((c) => runtime.commandInfo(c.name)?.contactOrPayment !== false).map((c) => c.name)).toEqual([]);
  });

  it('declares the writes of every command with agent approvers', () => {
    expect(shipped().filter((c) => c.agentApprovers !== undefined && c.writes === undefined).map((c) => c.name)).toEqual([]);
  });

  it('flags P04 on an agent proposal of every proposal command but the listed ones', () => {
    const commands = shipped();
    const runtime = new Runtime(cells, { manifests: manifests() }).register({ commands });
    const proposals = commands.filter((c) => c.access === 'proposal');
    expect(proposals.length).toBeGreaterThan(0);
    const clean = proposals.filter((c) => runtime.commandInfo(c.name)?.contactOrPayment === false).map((c) => c.name);
    expect(clean.filter((name) => !PROPOSALS_WITHOUT_P04.includes(name))).toEqual([]);
  });

  it('keeps every contact and payment column of the manifests', () => {
    const classes = new Map<string, string>();
    for (const tables of manifests()) {
      for (const [schema, byTable] of Object.entries(tables)) {
        for (const [table, columns] of Object.entries(byTable)) {
          for (const [column, cls] of Object.entries(columns)) classes.set(`${schema}.${table}.${column}`, cls);
        }
      }
    }
    const lost = Object.entries(P04_COLUMNS).filter(([column, cls]) => classes.get(column) !== cls);
    expect(lost).toEqual([]);
  });
});
