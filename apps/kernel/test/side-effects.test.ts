// Every command declares what it does beyond its transaction, and its risk is at least what that derives (plan §4.2,
// §4.7 "Derived risk", #1563). Runtime.register() refuses a declared risk below the derived one; this test fails when a
// command of any module declares none.
import { describe, expect, it } from 'vitest';
import { kernelCommands } from '@crove/kernel';
import type { Db } from '@crove/db';
import { Runtime, deriveRisk, type CommandDef } from '@crove/kernel-runtime';
import { crmCommands } from '@crove/mod-crm';
import { financeCommands } from '@crove/mod-finance';
import { socialCommands } from '@crove/mod-social';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { numberReseedCommand } from '../src/restore-report.ts';
import { TEST_MANIFESTS } from './manifests.ts';

// Commands whose R3 is policy, not side effect: who may change membership and roles (pinned so an annotation cannot
// lower them).
const POLICY_R3 = ['kernel.member.change_role', 'kernel.member.invite.create', 'kernel.member.remove', 'kernel.member.role.assign', 'kernel.member.role.revoke'];
// Finance commands whose risk is policy, above what their side effect derives (pinned so an annotation cannot lower
// them): the period lock and unlock of ADR-0021 section 7.
const FINANCE_POLICY = { 'finance.period.lock': 'R2', 'finance.period.unlock': 'R3' } as const;

const all = (): Array<CommandDef<unknown, unknown>> =>
  [...kernelCommands, orgPurgeCommand({ store: {} as never }), numberReseedCommand(), ...financeCommands, ...socialCommands, ...crmCommands] as Array<CommandDef<unknown, unknown>>;

describe('declared risk and side effects (#1563)', () => {
  it('derives R3 from financial, legal and irreversible effects, R2 from external, R1 from internal, R0 from none', () => {
    expect(['financial', 'legal', 'irreversible', 'external', 'internal', 'none'].map((e) => deriveRisk(e as never))).toEqual(['R3', 'R3', 'R3', 'R2', 'R1', 'R0']);
  });

  it('refuses to register a command whose risk is below the risk its side effect derives', () => {
    const runtime = new Runtime({} as Db, { manifests: TEST_MANIFESTS });
    const def = (risk: 'R1' | 'R3', sideEffect: 'financial' | 'internal') =>
      ({ name: `test.side_effect_${risk}_${sideEffect}`, input: {} as never, risk, sideEffect, access: ['owner'], handler: async () => null }) as unknown as CommandDef<unknown, unknown>;
    expect(() => runtime.register({ commands: [def('R1', 'financial')] })).toThrow(/declared risk R1 is below R3/);
    expect(() => runtime.register({ commands: [def('R3', 'internal'), def('R3', 'financial')] })).not.toThrow();
  });

  it('registers every module with its declared risks', () => {
    expect(() => new Runtime({} as Db, { manifests: TEST_MANIFESTS }).register({ commands: all() })).not.toThrow();
  });

  it('declares a side effect on every command of every module (#1563, #1577, #1578, #1579)', () => {
    const missing = all()
      .filter((c) => c.sideEffect === undefined)
      .map((c) => c.name)
      .sort();
    expect(missing).toEqual([]);
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

  it('declares the crm commands that mail a customer or change the public booking page as external effects, R2 (#1579)', () => {
    const byName = new Map(all().map((c) => [c.name, c]));
    for (const name of [
      'crm.booking.cancel',
      'crm.booking.confirm',
      'crm.booking.manage',
      'crm.booking.move',
      'crm.booking.remind',
      'crm.event_type.create',
      'crm.event_type.set_active',
      'crm.event_type.update',
    ]) {
      expect(byName.get(name), name).toMatchObject({ risk: 'R2', sideEffect: 'external' });
    }
  });

  it('declares the social commands that start a platform call, queue mail, post to a chat or change a public page as external effects, R2 (#1578)', () => {
    const byName = new Map(all().map((c) => [c.name, c]));
    for (const name of [
      'social.auto_reply.begin',
      'social.bio.save',
      'social.chat_alert.test',
      'social.comment.begin',
      'social.digest.send',
      'social.edit.begin',
      'social.gate.begin',
      'social.notification.dispatch',
      'social.pin.begin',
      'social.playlist.begin',
      'social.publish.begin',
      'social.remove.begin',
      'social.report_branding.remove',
      'social.report_branding.save',
      'social.report_schedule.run',
      'social.report_schedule.test',
      'social.repost.begin',
      'social.review.reply',
      'social.thread.begin',
    ]) {
      expect(byName.get(name), name).toMatchObject({ risk: 'R2', sideEffect: 'external' });
    }
    // What the worker records of a platform's answer is a write inside Crove, so R1, not R0.
    for (const name of ['social.external_post.import', 'social.external_post.record', 'social.late_id.record', 'social.metrics.record']) {
      expect(byName.get(name), name).toMatchObject({ risk: 'R1', sideEffect: 'internal' });
    }
  });

  it('declares the finance commands that post to the ledger as financial, and the year archive as legal, R3 (#1577)', () => {
    const byName = new Map(all().map((c) => [c.name, c]));
    for (const name of [
      'finance.closing.record',
      'finance.depreciation.record',
      'finance.journal.reverse',
      'finance.journal_voucher.record',
      'finance.opening_balance.post',
      'finance.purchase.record',
      'finance.voucher.record',
    ]) {
      expect(byName.get(name), name).toMatchObject({ risk: 'R3', sideEffect: 'financial' });
    }
    expect(byName.get('finance.archive.build')).toMatchObject({ risk: 'R3', sideEffect: 'legal' });
  });

  it('declares the finance commands that queue mail or call the tax portal as external effects, R2 (#1577)', () => {
    const byName = new Map(all().map((c) => [c.name, c]));
    for (const name of ['finance.missing_invoices.remind', 'finance.missing_invoices.request', 'finance.portal_sync.call']) {
      expect(byName.get(name), name).toMatchObject({ risk: 'R2', sideEffect: 'external' });
      // None is open to agents, so no actor's rights change.
      expect(byName.get(name)?.agent, name).toBeUndefined();
    }
    // The reminder stays a system command: the runtime gates the worker by access, not risk.
    expect(byName.get('finance.missing_invoices.remind')).toMatchObject({ access: 'system' });
  });

  it('keeps the finance period lock and unlock at their policy risk', () => {
    const byName = new Map(all().map((c) => [c.name, c]));
    for (const [name, risk] of Object.entries(FINANCE_POLICY)) expect(byName.get(name), name).toMatchObject({ risk, sideEffect: 'internal' });
  });

  it('keeps the membership and role commands at R3', () => {
    const byName = new Map(all().map((c) => [c.name, c.risk]));
    for (const name of POLICY_R3) expect(byName.get(name), name).toBe('R3');
  });
});
