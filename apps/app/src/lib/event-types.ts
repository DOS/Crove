// Helpers for the event types card in Settings (issue #1314). The server enforces every rule; these only turn the form
// into the saved shape and keep it from offering what cannot succeed.
import { slugOf, type EventType, type EventTypeInput, type EventTypeLocationKind } from '@crove/kernel-contract';

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
  };
}

/** The draft after the title changed: the slug follows it until the user edits the slug. */
export function withTitle(draft: EventTypeDraft, title: string): EventTypeDraft {
  return { ...draft, title, slug: draft.slugEdited ? draft.slug : slugOf(title) };
}

const whole = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/** The input to save, or the name of the first field that is not a whole number where one is needed. */
export function inputOf(draft: EventTypeDraft): { input: EventTypeInput } | { invalid: keyof EventTypeDraft } {
  const numbers = {
    durationMin: whole(draft.durationMin),
    bufferBeforeMin: whole(draft.bufferBeforeMin),
    bufferAfterMin: whole(draft.bufferAfterMin),
    horizonDays: whole(draft.horizonDays),
  };
  for (const [key, value] of Object.entries(numbers)) if (value === null) return { invalid: key as keyof EventTypeDraft };
  const noticeHours = Number(draft.minNoticeHours.trim().replace(',', '.'));
  if (draft.minNoticeHours.trim() === '' || !Number.isFinite(noticeHours) || noticeHours < 0) return { invalid: 'minNoticeHours' };
  const dailyLimit = draft.dailyLimit.trim() === '' ? null : whole(draft.dailyLimit);
  if (draft.dailyLimit.trim() !== '' && dailyLimit === null) return { invalid: 'dailyLimit' };
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
    },
  };
}

/** Who the form offers as host: owners and admins pick any member who may edit a calendar; a member only themselves. */
export function hostChoices(members: readonly EventTypeMember[], me: string, manager: boolean): EventTypeMember[] {
  const hosts = members.filter((m) => m.role !== 'viewer');
  return manager ? hosts : hosts.filter((m) => m.userId === me);
}

/** Whether the user may change this event type: owners and admins all, a member those they host. */
export function mayManage(type: EventType, me: string, manager: boolean): boolean {
  return manager || type.hostUserId === me;
}
