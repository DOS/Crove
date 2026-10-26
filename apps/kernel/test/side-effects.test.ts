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
import { orgPurgeCommand } from '../src/org-purge.ts';

// Commands without a side effect, per module. Annotating a module's commands shrinks its list; a new command must
// declare one. Every kernel command declares one.
const UNANNOTATED_KERNEL: string[] = [];
// Commands whose R3 is policy, not side effect: who may change membership and roles (pinned so an annotation cannot
// lower them).
const POLICY_R3 = ['kernel.member.change_role', 'kernel.member.invite.create', 'kernel.member.remove', 'kernel.member.role.assign', 'kernel.member.role.revoke'];
// The other modules' commands without a side effect, per module (follow-ups of #1563, one per lead): exact, so an
// annotation lowers its module's number in the same PR and a new unannotated command fails.
const UNANNOTATED_CEILING: Record<string, number> = { finance: 45, social: 158, crm: 12 };

const all = (): Array<CommandDef<unknown, unknown>> =>
  [...kernelCommands, orgPurgeCommand({ store: {} as never }), ...financeCommands, ...socialCommands, ...crmCommands] as Array<CommandDef<unknown, unknown>>;

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
    expect(counts).toEqual(UNANNOTATED_CEILING);
  });

  it('declares the commands that queue mail or run an approved proposal as external effects, R2 (#1563)', () => {
    const byName = new Map(all().map((c) => [c.name, c]));
    for (const name of ['kernel.agent.proposal.approve', 'kernel.mail.contact.queue', 'kernel.proposal.remind', 'kernel.usage.defer']) {
      expect(byName.get(name), name).toMatchObject({ risk: 'R2', sideEffect: 'external' });
    }
    // Three are system commands no agent may run (no agent access): the runtime gates a system actor by access, not
    // risk, so the reminder, deferral and agent-approval jobs run as before (their database tests run them as the
    // system: proposal-reminders, the usage limits and the T18 agents invariant). What an agent may approve is decided
    // by the approved proposal's command (R1 or R2, within max_risk), never by kernel.agent.proposal.approve's own risk.
    for (const name of ['kernel.agent.proposal.approve', 'kernel.proposal.remind', 'kernel.usage.defer']) {
      expect(byName.get(name), name).toMatchObject({ access: 'system' });
      expect(byName.get(name)?.agent, name).toBeUndefined();
    }
  });

  it('keeps the membership and role commands at R3', () => {
    const byName = new Map(all().map((c) => [c.name, c.risk]));
    for (const name of POLICY_R3) expect(byName.get(name), name).toBe('R3');
  });

  it('leaves only the listed kernel commands without a side effect', () => {
    const missing = all()
      .filter((c) => c.sideEffect === undefined && c.name.startsWith('kernel.'))
      .map((c) => c.name)
      .sort();
    expect(missing).toEqual(UNANNOTATED_KERNEL);
  });
});
