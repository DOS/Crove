// Every registered command and query has a label in Vietnamese and English (plan "Valid registry", DESIGN.md: every
// visible string has a key in both languages, #1654): the app's catalogs hold them under `commands`, by the dotted
// parts of the name, and the audit log and its export show them. A new command without both labels fails here, and so
// does a label whose command is gone. The real audit export, run through the app's label column, keeps every cell.
import { auditCsv } from '@crove/kernel';
import { describe, expect, it } from 'vitest';
import { en } from '../../app/src/i18n/messages/en.ts';
import { vi } from '../../app/src/i18n/messages/vi.ts';
import { commandLabel, withCommandLabels, type CommandLabels } from '../../app/src/lib/audit.ts';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { numberReseedCommand } from '../src/restore-report.ts';

// Every name the kernel's runtimes register: the modules' commands and queries with every module on, and the operator's
// org purge and number reseed.
function registeredNames(): string[] {
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' });
  const { commands, queries } = moduleDefinitions(config);
  return [...commands, orgPurgeCommand({ store: {} as never }), numberReseedCommand(), ...queries].map((d) => d.name);
}

// The dotted names a catalog's labels stand for.
function labelNames(labels: CommandLabels, prefix = ''): string[] {
  return Object.entries(labels).flatMap(([part, value]) => (typeof value === 'string' ? [`${prefix}${part}`] : labelNames(value, `${prefix}${part}.`)));
}

// What is wrong between the registered names and the catalogs' labels, one line each.
function labelProblems(names: readonly string[], catalogs: Record<string, CommandLabels>): string[] {
  const problems: string[] = [];
  const registered = new Set(names);
  for (const [locale, labels] of Object.entries(catalogs)) {
    for (const name of names) {
      if (!commandLabel(labels, name)?.trim()) problems.push(`${name} has no ${locale} label: add it under commands in apps/app/src/i18n/messages/${locale}.ts`);
    }
    for (const name of labelNames(labels)) {
      if (!registered.has(name)) problems.push(`${name} has a ${locale} label but is not registered: remove it from apps/app/src/i18n/messages/${locale}.ts`);
    }
  }
  return problems;
}

describe('command labels (#1654)', () => {
  it('labels every registered command and query in Vietnamese and English, and nothing else', () => {
    const names = registeredNames();
    expect(names.length).toBeGreaterThan(400);
    expect(labelProblems(names, { vi: vi.commands, en: en.commands })).toEqual([]);
  });

  it('reports a planted command without a label, and a label without a command', () => {
    const catalogs = { vi: { kernel: { proposal: { approve: 'Duyệt đề xuất', old: 'Lệnh cũ' } } }, en: { kernel: { proposal: { approve: 'Approve a proposal', old: 'Old' } } } };
    expect(labelProblems(['kernel.proposal.approve', 'kernel.proposal.planted'], catalogs)).toEqual([
      'kernel.proposal.planted has no vi label: add it under commands in apps/app/src/i18n/messages/vi.ts',
      'kernel.proposal.old has a vi label but is not registered: remove it from apps/app/src/i18n/messages/vi.ts',
      'kernel.proposal.planted has no en label: add it under commands in apps/app/src/i18n/messages/en.ts',
      'kernel.proposal.old has a en label but is not registered: remove it from apps/app/src/i18n/messages/en.ts',
    ]);
    expect(labelProblems(['kernel.proposal.approve'], { vi: { kernel: { proposal: { approve: ' ' } } } })).toEqual([
      'kernel.proposal.approve has no vi label: add it under commands in apps/app/src/i18n/messages/vi.ts',
    ]);
  });

  it('adds the label column to the real export and keeps every cell of it', () => {
    const entry = { id: 'e1', at: '2026-10-01T00:00:00.000Z', actorType: 'user' as const, actorId: 'u1', targetType: 'proposal', targetId: 't1', proposalId: null };
    const csv = auditCsv([
      { ...entry, actorName: 'Lê, Văn "A"', command: 'kernel.proposal.approve', outcome: 'ok', detail: 'a, b\r\nc' },
      { ...entry, actorName: '=HYPERLINK("x")', command: 'kernel.retired.command', outcome: 'failed', detail: null },
    ]);
    const labeled = withCommandLabels(csv, (name) => commandLabel(vi.commands, name));
    const lines = labeled.split('\r\n');
    expect(lines[0]).toBe('﻿occurred_at,actor_type,actor_id,actor_name,command,command_label,outcome,target_type,target_id,proposal_id,detail');
    expect(labeled).toContain(',kernel.proposal.approve,Duyệt đề xuất,ok,');
    expect(labeled).toContain(',kernel.retired.command,,failed,');
    // Without the added column, the file is the server's, byte for byte.
    expect(labeled.replace('command,command_label,', 'command,').replace(',Duyệt đề xuất,', ',').replace('kernel.retired.command,,', 'kernel.retired.command,')).toBe(csv);
  });
});
