// The crm module's booking slice (issue #1314, plan docs/plan/calendar.md): event types, the kinds of meeting a client
// books with a member on a public page (C3, #1318). The slot rules they carry feed freeSlots() in calendar.ts.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const EVENT_TYPE_LOCATION_KINDS = ['in_person', 'phone', 'video'] as const;
export type EventTypeLocationKind = (typeof EVENT_TYPE_LOCATION_KINDS)[number];

export const EVENT_TYPE_SLUG_MAX = 60;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A slug from a title: lower case, Vietnamese marks dropped, words joined by hyphens ("Tư vấn thuế" → "tu-van-thue"). */
export function slugOf(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, EVENT_TYPE_SLUG_MAX)
    .replace(/-+$/g, '');
}

export const zEventTypeInput = z.strictObject({
  slug: z.string().trim().max(EVENT_TYPE_SLUG_MAX).regex(SLUG, 'lower-case letters, digits and single hyphens'),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable(),
  durationMin: z.number().int().min(5).max(480),
  bufferBeforeMin: z.number().int().min(0).max(240),
  bufferAfterMin: z.number().int().min(0).max(240),
  minNoticeMin: z.number().int().min(0).max(43_200),
  horizonDays: z.number().int().min(1).max(365),
  dailyLimit: z.number().int().min(1).max(50).nullable(),
  locationKind: z.enum(EVENT_TYPE_LOCATION_KINDS),
  locationValue: z.string().trim().max(500).nullable(),
  hostUserId: zId,
});
export type EventTypeInput = z.infer<typeof zEventTypeInput>;

export const zEventType = zEventTypeInput.extend({
  id: zId,
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EventType = z.infer<typeof zEventType>;

export const zEventTypeUpdate = zEventTypeInput.extend({ eventTypeId: zId });
export const zEventTypeSetActive = z.strictObject({ eventTypeId: zId, active: z.boolean() });

// ---------------------------------------------------------------------------------------------------------------------
// The public booking page (issue #1318): what a visitor sees and sends. The page shows free slots only.

export const zBookingPage = z.strictObject({
  orgName: z.string(),
  eventType: z.strictObject({
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    durationMin: z.number().int(),
    locationKind: z.enum(EVENT_TYPE_LOCATION_KINDS),
  }),
  slots: z.array(z.strictObject({ start: z.string(), end: z.string() })),
});
export type BookingPage = z.infer<typeof zBookingPage>;

export const zBookingRequest = z.strictObject({
  startsAt: z.iso.datetime({ offset: true }),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  phone: z.string().trim().max(30).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  timeZone: z.string().min(1).max(64),
});
export type BookingRequest = z.infer<typeof zBookingRequest>;

export const BOOKING_STATUSES = ['pending', 'confirmed', 'refused', 'cancelled'] as const;
export const zBookingStatus = z.strictObject({
  status: z.enum(BOOKING_STATUSES),
  refusal: z.enum(['taken', 'unavailable']).nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
});
export type BookingStatus = z.infer<typeof zBookingStatus>;
