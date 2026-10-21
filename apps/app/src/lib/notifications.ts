// In-app notifications of the kernel and finance (#671): the kinds the settings list, what an item opens, and how a VAT
// period reads. Social's are apart (lib/social-notifications.ts, #637). No React imports, so it is unit tested.

// The kinds a member can turn off, by module, in the order the settings list them.
export const NOTIFICATION_KINDS = {
  kernel: ['kernel.approval_waiting', 'kernel.file_unreadable'],
  finance: ['finance.bank_attention', 'finance.portal_attention', 'finance.period_closing'],
} as const;
export type KnownNotificationKind = (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS][number];

// The kinds of the modules this deployment runs.
export function notificationKinds(modules: readonly string[]): KnownNotificationKind[] {
  return Object.entries(NOTIFICATION_KINDS).flatMap(([module, kinds]) => (module === 'kernel' || modules.includes(module) ? [...kinds] : []));
}

// The message key of a kind ('kernel.approval_waiting' is kinds.kernel_approval_waiting).
type Underscored<K extends string> = K extends `${infer M}.${infer N}` ? `${M}_${N}` : never;
export const kindKey = (kind: KnownNotificationKind) => kind.replace('.', '_') as Underscored<KnownNotificationKind>;

export const isKnownKind = (kind: string): kind is KnownNotificationKind => Object.values(NOTIFICATION_KINDS).some((kinds) => (kinds as readonly string[]).includes(kind));

export type NotificationTarget =
  | { to: 'proposal'; id: string }
  | { to: 'inbox' }
  | { to: 'bank'; account?: string }
  | { to: 'portal' }
  | { to: 'ledger' };

// What an item opens: the proposal waiting for approval, the Inbox (where a file that failed to read is listed), the
// bank account with lines to look at, the tax-portal check, or the ledger, where the period is locked.
export function notificationTarget(item: { kind: string; subjectId: string | null; detail: Record<string, string> }): NotificationTarget | null {
  switch (item.kind) {
    case 'kernel.approval_waiting':
      return item.subjectId ? { to: 'proposal', id: item.subjectId } : { to: 'inbox' };
    case 'kernel.file_unreadable':
      return { to: 'inbox' };
    case 'finance.bank_attention':
      return item.detail.bankAccount ? { to: 'bank', account: item.detail.bankAccount } : { to: 'bank' };
    case 'finance.portal_attention':
      return { to: 'portal' };
    case 'finance.period_closing':
      return { to: 'ledger' };
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
