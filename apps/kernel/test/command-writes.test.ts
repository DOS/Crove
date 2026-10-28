// What commands declare they write (CommandDef.writes, plan §4.7 "Derived risk", #1697): P04 applies to an agent's
// proposal of a command that writes a `contact` or `payment` column. Runtime.register() checks each declaration
// against the classes it carries; this test checks that those classes are the manifests', and holds the registry to
// the declarations P04 rests on: every command an agent may run declares its writes, and no proposal command escapes
// P04 without saying so here.
import { describe, expect, it } from 'vitest';
import { kernelCommands } from '@crove/kernel';
import { DATA_CLASSES } from '@crove/kernel-contract';
import type { Db } from '@crove/db';
import { Runtime, WRITE_DATA_CLASSES, type CommandDef } from '@crove/kernel-runtime';
import { crmCommands } from '@crove/mod-crm';
import { financeCommands } from '@crove/mod-finance';
import { socialCommands } from '@crove/mod-social';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { MODULE_MANIFESTS } from './manifest-permissions.ts';

const all = (): Array<CommandDef<unknown, unknown>> =>
  [...kernelCommands, orgPurgeCommand({ store: {} as never }), ...financeCommands, ...socialCommands, ...crmCommands] as Array<CommandDef<unknown, unknown>>;

// Proposal commands an agent's proposal of which is not flagged P04: their declared writes name no contact or payment
// column. None yet: every proposal command declares no writes, so P04 flags each one. Adding one here is a review of
// its declaration (plan §4.7).
const PROPOSALS_WITHOUT_P04: readonly string[] = [];

// The classes of every manifest table, by `<schema>.<table>`.
const manifestTables = new Map<string, Readonly<Record<string, string>>>();
for (const { manifest } of Object.values(MODULE_MANIFESTS)) {
  for (const [schema, tables] of Object.entries(manifest.tables)) {
    for (const [table, classes] of Object.entries(tables)) manifestTables.set(`${schema}.${table}`, classes);
  }
}

describe('declared command writes (#1697)', () => {
  const commands = all();
  const runtime = new Runtime({} as Db).register({ commands });

  it('knows the data classes the manifests use', () => {
    expect([...WRITE_DATA_CLASSES]).toEqual([...DATA_CLASSES]);
  });

  it('carries the classes of the manifests', () => {
    const problems: string[] = [];
    for (const c of commands) {
      for (const w of c.writes ?? []) {
        const classes = manifestTables.get(w.table);
        if (!classes) problems.push(`${c.name}: ${w.table} is in no manifest`);
        else if (
          Object.keys(w.classes).length !== Object.keys(classes).length ||
          Object.entries(w.classes).some(([column, cls]) => !Object.hasOwn(classes, column) || classes[column] !== cls)
        ) {
          problems.push(`${c.name}: the classes of ${w.table} are not its manifest's (build the write with tableWrite())`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('declares the writes of every command an agent may run, none of them a contact or payment column', () => {
    const agentCommands = commands.filter((c) => c.agent !== undefined);
    expect(agentCommands.length).toBeGreaterThan(0);
    expect(agentCommands.filter((c) => c.writes === undefined).map((c) => c.name)).toEqual([]);
    expect(agentCommands.filter((c) => runtime.commandInfo(c.name)?.contactOrPayment !== false).map((c) => c.name)).toEqual([]);
  });

  it('declares the writes of every command with agent approvers, never the old noContactOrPayment alone', () => {
    expect(commands.filter((c) => c.agentApprovers !== undefined && c.writes === undefined).map((c) => c.name)).toEqual([]);
  });

  it('flags P04 on an agent proposal of every proposal command but the listed ones', () => {
    const proposals = commands.filter((c) => c.access === 'proposal');
    expect(proposals.length).toBeGreaterThan(0);
    const clean = proposals.filter((c) => runtime.commandInfo(c.name)?.contactOrPayment === false).map((c) => c.name);
    expect(clean.sort()).toEqual([...PROPOSALS_WITHOUT_P04].sort());
  });
});
