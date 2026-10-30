// In-app notifications of the kernel, finance and notes (#671): the kinds the settings list, what an item opens, and how
// a VAT period reads. Social's are apart (lib/social-notifications.ts, #637). No React imports, so it is unit tested.

// The kinds a member can turn off, by module, in the order the settings list them.
export const NOTIFICATION_KINDS = {
  // A task that came to me because its holder can no longer read its legal entity (#1799).
  kernel: ['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_rerouted'],
  finance: ['finance.bank_attention', 'finance.portal_attention', 'finance.period_closing'],
  // A to-do's reminder (#1675): it holds no text, the to-do shows in My work.
  notes: ['notes.todo_due'],
} as const;
export type KnownNotificationKind = (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS][number];

// The kinds of the modules this deployment runs.
export function notificationKinds(modules: readonly string[]): KnownNotificationKind[] {
  return Object.entries(NOTIFICATION_KINDS).flatMap(([module, kinds]) => (module === 'kernel' || modules.includes(module) ? [...kinds] : []));
}

// The message key of a kind ('kernel.approval_waiting' is kinds.kernel_approval_waiting).
type Underscored<K extends string> = K extends `${infer M}.${infer N}` ? `${M}_${N}` : never;
export const kindKey = (kind: KnownNotificationKind) => kind.replace('.', '_') as Underscored<KnownNotificationKind>;

// Kinds shown but never turned off, so not in the settings: a notice an action waits on (#1678: a personal-data erasure
// deletes the private items it names once their authors were told).
export const REQUIRED_NOTIFICATION_KINDS = ['kernel.personal_data_notice'] as const;
type ShownNotificationKind = KnownNotificationKind | (typeof REQUIRED_NOTIFICATION_KINDS)[number];

export const isKnownKind = (kind: string): kind is ShownNotificationKind =>
  (REQUIRED_NOTIFICATION_KINDS as readonly string[]).includes(kind) || Object.values(NOTIFICATION_KINDS).some((kinds) => (kinds as readonly string[]).includes(kind));

export type NotificationTarget =
  | { to: 'proposal'; id: string }
  | { to: 'inbox' }
  | { to: 'bank'; account?: string }
  | { to: 'portal' }
  | { to: 'ledger' }
  | { to: 'myWork' }
  | { to: 'task'; id: string }
  | { to: 'tasks' };

// What an item opens: the proposal waiting for approval, the Inbox (where a file that failed to read is listed), the
// bank account with lines to look at, the tax-portal check, the ledger, where the period is locked, or My work, where
// the reminded to-do is, or the task that came to me (else the task list).
export function notificationTarget(item: { kind: string; subjectId: string | null; detail: Record<string, string> }): NotificationTarget | null {
  switch (item.kind) {
    case 'kernel.approval_waiting':
      return item.subjectId ? { to: 'proposal', id: item.subjectId } : { to: 'inbox' };
    case 'kernel.file_unreadable':
      return { to: 'inbox' };
    case 'kernel.task_rerouted':
      return item.subjectId ? { to: 'task', id: item.subjectId } : { to: 'tasks' };
    case 'finance.bank_attention':
      return item.detail.bankAccount ? { to: 'bank', account: item.detail.bankAccount } : { to: 'bank' };
    case 'finance.portal_attention':
      return { to: 'portal' };
    case 'finance.period_closing':
      return { to: 'ledger' };
    case 'notes.todo_due':
      return { to: 'myWork' };
    default:
      return null;
  }
}

// A VAT period key as people write it: '2026-09' is 09/2026, '2026-Q3' is Q3/2026 (the caller puts the word for quarter).
export function periodParts(period: string): { kind: 'month' | 'quarter'; label: string } | null {
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (month) return { kind: 'month', label: `${month[2]}/${month[1]}` };
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) return { kind: 'quarter', label: `${quarter[2]}/${quarter[1]}` };
  return null;
}
