// Invariant suite (Decision 7): how revisers and the proposal editor are registered (#161, #216). The runtime binds a
// reviser to the proposal editor's declaration (proposalEditor) on the calling definition, never to a command name,
// and the reviser of a proposal command comes from the registered `revises` alone. register() refuses a malformed
// editor declaration and a second editor; validate(), run at startup, refuses a registry in which a reviser could
// never run or two revisers claim one proposal command. No database needed. Keep this file self-contained: import
// package code under test, never helpers from outside test/invariant/.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CellResolver } from '@crove/db';
import { kernelCommands } from '@crove/kernel';
import { Runtime, defineCommand, type CommandDef } from '@crove/kernel-runtime';
import { financeCommands } from '@crove/mod-finance';

const noDatabase = (): never => {
  throw new Error('no database in this test');
};
const cells: CellResolver = { resolveTenant: async () => noDatabase(), controlPlane: () => noDatabase() };
const runtime = () => new Runtime(cells);

const base = { input: z.object({}), risk: 'R1' as const, handler: async () => ({}) };
const record = defineCommand({ ...base, name: 'test.thing.record', access: 'proposal' });
const list = defineCommand({ ...base, name: 'test.thing.list', access: ['owner'] });
const reviser = (name: string, revises: string) => defineCommand({ ...base, name, access: 'proposal_revision', revises });
const editor = (name = 'test.proposal.edit') => defineCommand({ ...base, name, access: ['owner', 'admin', 'member'], proposalEditor: true });

describe('reviser registry (#216)', () => {
  it('has the kernel edit command as the one proposal editor, and the shipped registry validates', () => {
    const editors = [...kernelCommands, ...financeCommands].filter((c) => c.proposalEditor === true);
    expect(editors.map((c) => c.name)).toEqual(['kernel.proposal.edit']);
    expect(() => runtime().register({ commands: [...kernelCommands, ...financeCommands] }).validate()).not.toThrow();
    // Every reviser the modules ship revises a command that runs through a proposal.
    const all = new Map([...kernelCommands, ...financeCommands].map((c) => [c.name, c] as const));
    const revisers = [...all.values()].filter((c) => c.access === 'proposal_revision');
    expect(revisers.length).toBeGreaterThan(0);
    for (const r of revisers) expect(all.get(r.revises ?? '')?.access).toBe('proposal');
  });

  it('refuses a proposal editor that users do not run, a malformed declaration and a second editor', () => {
    expect(() => runtime().register({ commands: [defineCommand({ ...base, name: 'test.editor', access: 'system', proposalEditor: true })] })).toThrow(
      /run by users/,
    );
    expect(() => runtime().register({ commands: [defineCommand({ ...base, name: 'test.editor', access: 'proposal', proposalEditor: true })] })).toThrow(
      /run by users/,
    );
    expect(() =>
      runtime().register({ commands: [defineCommand({ ...base, name: 'test.editor', access: 'proposal_revision', revises: record.name, proposalEditor: true })] }),
    ).toThrow(/run by users/);
    expect(() => runtime().register({ commands: [{ ...editor(), proposalEditor: 'yes' } as unknown as CommandDef] })).toThrow(/proposalEditor: true/);
    expect(() => runtime().register({ commands: [editor('test.a'), editor('test.b')] })).toThrow(/test\.a is already the proposal editor/);
    expect(() => runtime().register({ commands: [editor('test.a')] }).register({ commands: [editor('test.b')] })).toThrow(/test\.a is already the proposal editor/);
    // Next to the kernel's commands, another editor is refused under the kernel's name and under any other.
    expect(() => runtime().register({ commands: [...kernelCommands, editor('kernel.proposal.edit')] })).toThrow(/duplicate command kernel\.proposal\.edit/);
    expect(() => runtime().register({ commands: [...kernelCommands, editor('finance.test_editor')] })).toThrow(/kernel\.proposal\.edit is already the proposal editor/);
    // Registered before the kernel, a module's editor makes the kernel's own registration fail, so it never boots.
    expect(() => runtime().register({ commands: [editor('finance.test_editor')] }).register({ commands: kernelCommands })).toThrow(/already the proposal editor/);
  });

  it('fails startup validation when a reviser could never run or two revisers claim one command (#216)', () => {
    const invalid = (commands: CommandDef<any, any>[]) => () => runtime().register({ commands }).validate();
    // A typo in `revises` registers (a module may register before the command it revises), and fails validate().
    expect(() => runtime().register({ commands: [record, editor(), reviser('test.thing.revise', 'test.thing.recrod')] })).not.toThrow();
    expect(invalid([record, editor(), reviser('test.thing.revise', 'test.thing.recrod')])).toThrow(
      /reviser test\.thing\.revise revises test\.thing\.recrod, which is not a registered command/,
    );
    expect(invalid([list, editor(), reviser('test.thing.revise', list.name)])).toThrow(/revises test\.thing\.list, which does not run through a proposal/);
    expect(invalid([editor(), reviser('test.thing.revise', 'test.proposal.edit')])).toThrow(/revises test\.proposal\.edit, which does not run through a proposal/);
    expect(invalid([record, editor(), reviser('test.thing.revise', record.name), reviser('test.thing.revise_twice', 'test.thing.revise')])).toThrow(
      /revises test\.thing\.revise, which does not run through a proposal/,
    );
    expect(invalid([record, editor(), reviser('test.thing.revise', record.name), reviser('test.thing.revise_again', record.name)])).toThrow(
      /proposal command test\.thing\.record has more than one reviser: test\.thing\.revise, test\.thing\.revise_again/,
    );
    expect(invalid([record, reviser('test.thing.revise', record.name)])).toThrow(/no proposal editor/);
    // Every problem is reported at once.
    expect(invalid([list, reviser('test.thing.revise', list.name), reviser('test.other.revise', 'test.missing')])).toThrow(
      /does not run through a proposal[\s\S]*not a registered command[\s\S]*no proposal editor/,
    );
    // A consistent registry validates, with or without revisers.
    expect(() => runtime().register({ commands: [record, list, editor(), reviser('test.thing.revise', record.name)] }).validate()).not.toThrow();
    expect(() => runtime().register({ commands: [record, list] }).validate()).not.toThrow();
  });
});
