// The kernel's and finance's in-app notifications in the app (#671): the kinds the settings list, what an item opens
// and how a VAT period reads.
import { describe, expect, it } from 'vitest';
import { isKnownKind, kindKey, notificationKinds, notificationTarget, periodParts } from '../src/lib/notifications.ts';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';

describe('notificationKinds', () => {
  it("lists the kernel's kinds, and finance's where finance runs", () => {
    expect(notificationKinds(['finance'])).toEqual(['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_rerouted', 'finance.bank_attention', 'finance.portal_attention', 'finance.period_closing']);
    expect(notificationKinds(['social'])).toEqual(['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_rerouted']);
    expect(notificationKinds(['notes'])).toEqual(['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_rerouted', 'notes.todo_due']);
  });

  it('has a label for every kind in both languages', () => {
    for (const kind of notificationKinds(['finance', 'notes'])) {
      expect(vi.notifications.kinds[kindKey(kind)], kind).toBeTruthy();
      expect(en.notifications.kinds[kindKey(kind)], kind).toBeTruthy();
    }
    expect(isKnownKind('finance.period_closing')).toBe(true);
    expect(isKnownKind('social.comment')).toBe(false);
  });
});

describe('notificationTarget', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  it('opens what the notification is about', () => {
    expect(notificationTarget({ kind: 'kernel.approval_waiting', subjectId: id, detail: {} })).toEqual({ to: 'proposal', id });
    expect(notificationTarget({ kind: 'kernel.file_unreadable', subjectId: id, detail: {} })).toEqual({ to: 'inbox' });
    expect(notificationTarget({ kind: 'kernel.task_rerouted', subjectId: id, detail: { title: 'Việc' } })).toEqual({ to: 'tasks' });
    expect(notificationTarget({ kind: 'finance.bank_attention', subjectId: id, detail: { bankAccount: '1121' } })).toEqual({ to: 'bank', account: '1121' });
    expect(notificationTarget({ kind: 'finance.portal_attention', subjectId: id, detail: {} })).toEqual({ to: 'portal' });
    expect(notificationTarget({ kind: 'finance.period_closing', subjectId: null, detail: {} })).toEqual({ to: 'ledger' });
    expect(notificationTarget({ kind: 'notes.todo_due', subjectId: id, detail: {} })).toEqual({ to: 'myWork' });
    expect(notificationTarget({ kind: 'later.kind', subjectId: null, detail: {} })).toBeNull();
  });
});

describe('periodParts', () => {
  it('reads months and quarters', () => {
    expect(periodParts('2026-09')).toEqual({ kind: 'month', label: '09/2026' });
    expect(periodParts('2026-Q3')).toEqual({ kind: 'quarter', label: '3/2026' });
    expect(periodParts('2026-13')).toBeNull();
  });
});
