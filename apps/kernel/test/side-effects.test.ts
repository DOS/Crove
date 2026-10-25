// Every command declares what it does beyond its transaction, and its risk is at least what that derives (plan §4.2,
// §4.7 "Derived risk", #1563). Runtime.register() refuses a declared risk below the derived one; this test keeps the
// commands that declare no side effect yet to a list that may only shrink, module by module.
import { describe, expect, it } from 'vitest';
import { kernelCommands } from '@crove/kernel';
import type { Db } from '@crove/db';
import { Runtime, deriveRisk, type CommandDef } from '@crove/kernel-runtime';
import { crmCommands } from '@crove/mod-crm';
import { financeCommands } from '@crove/mod-finance';
import { socialCommands } from '@crove/mod-social';

// Commands without a side effect, per module. Annotating a module's commands shrinks its list; a new command must
// declare one. Every kernel command declares one.
const UNANNOTATED_KERNEL: string[] = [];
// The other modules' commands without a side effect on 2026-10-26, per module (follow-ups of #1563, one per lead).
const UNANNOTATED_CEILING: Record<string, number> = { finance: 45, social: 158, crm: 12 };

const all = (): Array<CommandDef<unknown, unknown>> => [...kernelCommands, ...financeCommands, ...socialCommands, ...crmCommands] as Array<CommandDef<unknown, unknown>>;

describe('declared risk and side effects (#1563)', () => {
  it('derives R3 from financial, legal and irreversible effects, R2 from external, R1 from internal, R0 from none', () => {
    expect(['financial', 'legal', 'irreversible', 'external', 'internal', 'none'].map((e) => deriveRisk(e as never))).toEqual(['R3', 'R3', 'R3', 'R2', 'R1', 'R0']);
  });

  it('refuses to register a command whose risk is below the risk its side effect derives', () => {
    const runtime = new Runtime({} as Db);
    const def = (risk: 'R1' | 'R3', sideEffect: 'financial' | 'internal') =>
      ({ name: `test.side_effect_${risk}_${sideEffect}`, input: {} as never, risk, sideEffect, access: ['owner'], handler: async () => null }) as unknown as CommandDef<unknown, unknown>;
    expect(() => runtime.register({ commands: [def('R1', 'financial')] })).toThrow(/declared risk R1 is below R3/);
    expect(() => runtime.register({ commands: [def('R3', 'internal'), def('R3', 'financial')] })).not.toThrow();
  });

  it('registers every module with its declared risks', () => {
    expect(() => new Runtime({} as Db).register({ commands: all() })).not.toThrow();
  });

  it('lets the modules not annotated yet only lose unannotated commands', () => {
    const counts: Record<string, number> = {};
    for (const c of all()) {
      const module = c.name.split('.')[0] as string;
      if (c.sideEffect === undefined && module !== 'kernel') counts[module] = (counts[module] ?? 0) + 1;
    }
    // Lower a ceiling when a module's commands are annotated; a new command without a side effect fails here.
    for (const [module, count] of Object.entries(counts)) expect(count, module).toBeLessThanOrEqual(UNANNOTATED_CEILING[module] ?? 0);
  });

  it('declares a mail queued to a contact as an external effect, R2 (#1563)', () => {
    const queue = all().find((c) => c.name === 'kernel.mail.contact.queue');
    expect(queue).toMatchObject({ risk: 'R2', sideEffect: 'external' });
  });

  it('leaves only the listed kernel commands without a side effect', () => {
    const missing = all()
      .filter((c) => c.sideEffect === undefined && c.name.startsWith('kernel.'))
      .map((c) => c.name)
      .sort();
    expect(missing).toEqual(UNANNOTATED_KERNEL);
  });
});
