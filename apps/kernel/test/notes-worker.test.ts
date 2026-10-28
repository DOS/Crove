// The notes module's worker part (issue #1671, ADR-0037 §4): a member's removal queues the purge of their private notes
// 30 days later, with ids only; other events queue nothing.
import type { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { QUEUES } from '../src/jobs-schema.ts';
import { queueNotesMemberPurge } from '../src/notes-worker.ts';

function fakeBoss() {
  const sent: Array<{ queue: string; data: unknown; options: Record<string, unknown> }> = [];
  const boss = {
    send: async (queue: string, data: unknown, options: Record<string, unknown>) => {
      sent.push({ queue, data, options });
      return 'job';
    },
  } as unknown as PgBoss;
  return { boss, sent };
}

describe('notes worker (#1671)', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const row = { org_id: 'org-1', event_id: 'event-1', type: 'kernel.member.removed', payload: { userId: 'user-1', oldRole: 'member' } };

  it('queues the purge of a removed member 30 days later, with ids only', async () => {
    const { boss, sent } = fakeBoss();
    await queueNotesMemberPurge(boss, row, now);
    expect(sent).toEqual([
      {
        queue: QUEUES.notesMemberPurge,
        data: { orgId: 'org-1', userId: 'user-1' },
        options: expect.objectContaining({ singletonKey: 'org-1:user-1:event-1', startAfter: new Date('2026-12-01T00:00:00Z') }),
      },
    ]);
  });

  it('queues nothing for another event or a payload without a user', async () => {
    const { boss, sent } = fakeBoss();
    expect(queueNotesMemberPurge(boss, { ...row, type: 'kernel.member.role_changed' }, now)).toBeNull();
    expect(queueNotesMemberPurge(boss, { ...row, payload: {} }, now)).toBeNull();
    expect(sent).toEqual([]);
  });
});
