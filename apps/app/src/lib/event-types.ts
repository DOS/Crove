// Helpers for the event types card in Settings (issue #1314). The server enforces every rule; these only turn the form
// into the saved shape and keep it from offering what cannot succeed.
import { EVENT_TYPE_CO_HOSTS_MAX, slugOf, type EventType, type EventTypeAssignment, type EventTypeInput, type EventTypeLocationKind } from '@crove/kernel-contract';

export interface EventTypeMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

// The form keeps numbers as typed text, so a field may be empty while the user edits it.
export interface EventTypeDraft {
  title: string;
  slug: string;
  // Whether the user typed the slug; until then it follows the title.
  slugEdited: boolean;
  description: string;
  durationMin: string;
  bufferBeforeMin: string;
  bufferAfterMin: string;
  minNoticeHours: string;
  horizonDays: string;
  dailyLimit: string;
  locationKind: EventTypeLocationKind;
  locationValue: string;
  hostUserId: string;
  // Team types (#1373): who books it, and the hosts beside the lead (kept while the user switches back and forth).
  assignment: EventTypeAssignment;
  coHostUserIds: string[];
}

export function draftOf(type: EventType | null, hostUserId: string): EventTypeDraft {
  if (!type) {
    return {
      title: '',
      slug: '',
      slugEdited: false,
      description: '',
      durationMin: '30',
      bufferBeforeMin: '0',
      bufferAfterMin: '0',
      minNoticeHours: '4',
      horizonDays: '60',
      dailyLimit: '',
      locationKind: 'video',
      locationValue: '',
      hostUserId,
      assignment: 'single',
      coHostUserIds: [],
    };
  }
  return {
    title: type.title,
    slug: type.slug,
    slugEdited: true,
    description: type.description ?? '',
    durationMin: String(type.durationMin),
    bufferBeforeMin: String(type.bufferBeforeMin),
    bufferAfterMin: String(type.bufferAfterMin),
    minNoticeHours: String(type.minNoticeMin / 60),
    horizonDays: String(type.horizonDays),
    dailyLimit: type.dailyLimit === null ? '' : String(type.dailyLimit),
    locationKind: type.locationKind,
    locationValue: type.locationValue ?? '',
    hostUserId: type.hostUserId,
    assignment: type.assignment,
    coHostUserIds: type.coHostUserIds,
  };
}

/** The draft with this lead host: they leave the co-hosts if they were one. */
export function withHost(draft: EventTypeDraft, hostUserId: string): EventTypeDraft {
  return { ...draft, hostUserId, coHostUserIds: draft.coHostUserIds.filter((id) => id !== hostUserId) };
}

/** The draft with a co-host added or taken off, up to the most a team holds. */
export function withCoHost(draft: EventTypeDraft, userId: string, on: boolean): EventTypeDraft {
  const rest = draft.coHostUserIds.filter((id) => id !== userId);
  if (!on || userId === draft.hostUserId) return { ...draft, coHostUserIds: rest };
  return rest.length >= EVENT_TYPE_CO_HOSTS_MAX ? draft : { ...draft, coHostUserIds: [...rest, userId] };
}

/** The draft after the title changed: the slug follows it until the user edits the slug. */
export function withTitle(draft: EventTypeDraft, title: string): EventTypeDraft {
  return { ...draft, title, slug: draft.slugEdited ? draft.slug : slugOf(title) };
}

const whole = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

const noticeHoursOf = (text: string): number | null => {
  const hours = Number(text.trim().replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(hours) || hours < 0 ? null : hours;
};

/** The fields the form checks, in the order inputOf reports them. */
export const EVENT_TYPE_CHECKED_FIELDS = ['durationMin', 'bufferBeforeMin', 'bufferAfterMin', 'horizonDays', 'minNoticeHours', 'dailyLimit', 'coHostUserIds'] as const;
export type EventTypeCheckedField = (typeof EVENT_TYPE_CHECKED_FIELDS)[number];

/** Whether this field of the draft stops the save: a number that is not one, or a team without co-hosts. */
export function eventTypeFieldInvalid(draft: EventTypeDraft, field: EventTypeCheckedField): boolean {
  switch (field) {
    case 'minNoticeHours':
      return noticeHoursOf(draft.minNoticeHours) === null;
    case 'dailyLimit':
      return draft.dailyLimit.trim() !== '' && whole(draft.dailyLimit) === null;
    case 'coHostUserIds':
      return draft.assignment !== 'single' && draft.coHostUserIds.length === 0;
    default:
      return whole(draft[field]) === null;
  }
}

/** The input to save, or the name of the first field that is not a whole number where one is needed. */
export function inputOf(draft: EventTypeDraft): { input: EventTypeInput } | { invalid: EventTypeCheckedField } {
  const invalid = EVENT_TYPE_CHECKED_FIELDS.find((field) => eventTypeFieldInvalid(draft, field));
  if (invalid) return { invalid };
  const numbers = {
    durationMin: whole(draft.durationMin),
    bufferBeforeMin: whole(draft.bufferBeforeMin),
    bufferAfterMin: whole(draft.bufferAfterMin),
    horizonDays: whole(draft.horizonDays),
  };
  const noticeHours = noticeHoursOf(draft.minNoticeHours) as number;
  const dailyLimit = draft.dailyLimit.trim() === '' ? null : whole(draft.dailyLimit);
  const team = draft.assignment !== 'single';
  return {
    input: {
      slug: draft.slug.trim(),
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      durationMin: numbers.durationMin as number,
      bufferBeforeMin: numbers.bufferBeforeMin as number,
      bufferAfterMin: numbers.bufferAfterMin as number,
      minNoticeMin: Math.round(noticeHours * 60),
      horizonDays: numbers.horizonDays as number,
      dailyLimit,
      locationKind: draft.locationKind,
      locationValue: draft.locationValue.trim() || null,
      hostUserId: draft.hostUserId,
      assignment: draft.assignment,
      // A single type has none; switching back from a team drops them.
      coHostUserIds: team ? draft.coHostUserIds : [],
    },
  };
}

/** Who the form offers as host: owners and admins pick any member who may edit a calendar; a member only themselves. */
export function hostChoices(members: readonly EventTypeMember[], me: string, manager: boolean): EventTypeMember[] {
  const hosts = members.filter((m) => m.role !== 'viewer');
  return manager ? hosts : hosts.filter((m) => m.userId === me);
}

/** Who the form offers as co-host of a team type: any member who may edit a calendar, but the lead host. */
export function coHostChoices(members: readonly EventTypeMember[], hostUserId: string): EventTypeMember[] {
  return members.filter((m) => m.role !== 'viewer' && m.userId !== hostUserId);
}

/** Whether the user may change this event type: owners and admins all, a member those they host. */
export function mayManage(type: EventType, me: string, manager: boolean): boolean {
  return manager || type.hostUserId === me;
}
