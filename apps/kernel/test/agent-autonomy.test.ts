// The agent autonomy table (plan §4.7, #1585): docs/generated/agent-autonomy.md lists, from the registered commands,
// what an AI agent may run by itself and which proposals it may approve. The file is a protected path, so a change to
// agent access or agent approvers makes its PR protected (security review). This test fails when the file is stale.
// Regenerate it with: CROVE_UPDATE_AUTONOMY=1 pnpm exec vitest run --project unit apps/kernel/test/agent-autonomy.test.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { kernelCommands } from '@crove/kernel';
import type { CommandDef } from '@crove/kernel-runtime';
import { crmCommands } from '@crove/mod-crm';
import { financeCommands } from '@crove/mod-finance';
import { socialCommands } from '@crove/mod-social';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { numberReseedCommand } from '../src/restore-report.ts';

const FILE = fileURLToPath(new URL('../../../docs/generated/agent-autonomy.md', import.meta.url));

const all = (): Array<CommandDef<unknown, unknown>> =>
  [...kernelCommands, orgPurgeCommand({ store: {} as never }), numberReseedCommand(), ...financeCommands, ...socialCommands, ...crmCommands] as Array<CommandDef<unknown, unknown>>;

const roles = (r: readonly string[] | 'any') => (r === 'any' ? 'any position' : r.map((k) => `\`${k}\``).join(', '));

export function autonomyTable(commands: Array<CommandDef<unknown, unknown>>): string {
  const byName = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const runs = byName.filter((c) => c.agent !== undefined);
  const approves = byName.filter((c) => c.agentApprovers !== undefined);
  const lines = [
    '# Agent autonomy',
    '',
    'Generated from the registered commands by `apps/kernel/test/agent-autonomy.test.ts`; do not edit by hand. This file is a protected path (AGENTS.md): a pull request that changes what an AI agent may do changes this file and gets a security review (plan §4.7).',
    '',
    '## Commands an agent may run by itself',
    '',
    'An agent holding a position runs these without asking a human, within its `max_risk` (P02). A command at R2 or R3 is never run by an agent: it asks for a proposal instead (P05, P06). A tainted run (one that read outside input) may run only the commands marked "yes, it carries the taint forward" (P03).',
    '',
    ...(runs.length === 0
      ? ['None today.']
      : [
          '| Command | Risk | Positions | Tainted run |',
          '| --- | --- | --- | --- |',
          ...runs.map((c) => `| \`${c.name}\` | ${c.risk} | ${roles(c.agent!.roles)} | ${c.agent!.taint === 'propagate' ? 'yes, it carries the taint forward' : 'no'} |`),
        ]),
    '',
    '## Proposals an agent may approve',
    '',
    'An agent in one of these positions may approve a pending proposal of the command, only when the proposal is clean (no P03 to P07 flag), assessed, within its `max_risk`, outside its own work and causal chain and its reporting line, and asked through the review task the dispatch created (ADR-0029, T18). R3 proposals are always decided by a human.',
    '',
    ...(approves.length === 0
      ? ['None today: no proposal command declares agent approvers, so every proposal is decided by a human.']
      : ['| Proposal command | Risk | Positions |', '| --- | --- | --- |', ...approves.map((c) => `| \`${c.name}\` | ${c.risk} | ${roles(c.agentApprovers!.roles)} |`)]),
    '',
  ];
  return lines.join('\n');
}

describe('agent autonomy table (#1585)', () => {
  it('matches the registered commands', () => {
    const generated = autonomyTable(all());
    if (process.env.CROVE_UPDATE_AUTONOMY === '1') writeFileSync(FILE, generated);
    const current = (() => {
      try {
        return readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
      } catch {
        return '';
      }
    })();
    expect(current, 'docs/generated/agent-autonomy.md is stale: CROVE_UPDATE_AUTONOMY=1 pnpm exec vitest run --project unit apps/kernel/test/agent-autonomy.test.ts').toBe(generated);
  });

  it('lists no agent-run command at R2 or R3', () => {
    expect(all().filter((c) => c.agent !== undefined && (c.risk === 'R2' || c.risk === 'R3')).map((c) => c.name)).toEqual([]);
  });
});
