// The event types card's helpers (issue #1314): the form to the saved input and back, the slug that follows the
// title, and who may host or manage.
import { describe, expect, it } from 'vitest';
import { slugOf, type EventType } from '@crove/kernel-contract';
import { draftOf, hostChoices, inputOf, mayManage, withTitle, type EventTypeMember } from '../src/lib/event-types.ts';

const ME = '00000000-0000-7000-8000-000000000001';
const OTHER = '00000000-0000-7000-8000-000000000002';
const VIEWER = '00000000-0000-7000-8000-000000000003';
const members: EventTypeMember[] = [
  { userId: ME, email: 'me@example.test', displayName: 'Me', role: 'member' },
  { userId: OTHER, email: 'other@example.test', displayName: null, role: 'owner' },
  { userId: VIEWER, email: 'viewer@example.test', displayName: null, role: 'viewer' },
];

describe('event type form', () => {
  it('makes a slug from a Vietnamese title', () => {
    expect(slugOf('Tư vấn thuế 30 phút')).toBe('tu-van-thue-30-phut');
    expect(slugOf('  Đối soát  sổ sách!! ')).toBe('doi-soat-so-sach');
    expect(slugOf('a'.repeat(80))).toHaveLength(60);
  });

  it('lets the slug follow the title until the user edits it', () => {
    const fresh = withTitle(draftOf(null, ME), 'Gặp kế toán');
    expect(fresh.slug).toBe('gap-ke-toan');
    expect(withTitle({ ...fresh, slug: 'rieng', slugEdited: true }, 'Khác').slug).toBe('rieng');
  });

  it('turns the form into the input, notice in hours and an empty limit as none', () => {
    const draft = { ...withTitle(draftOf(null, ME), 'Tư vấn'), minNoticeHours: '1,5', dailyLimit: '', locationValue: '  ' };
    expect(inputOf(draft)).toEqual({
      input: {
        slug: 'tu-van',
        title: 'Tư vấn',
        description: null,
        durationMin: 30,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        minNoticeMin: 90,
        horizonDays: 60,
        dailyLimit: null,
        locationKind: 'video',
        locationValue: null,
        hostUserId: ME,
      },
    });
    expect(inputOf({ ...draft, durationMin: '30.5' })).toEqual({ invalid: 'durationMin' });
    expect(inputOf({ ...draft, dailyLimit: 'x' })).toEqual({ invalid: 'dailyLimit' });
    expect(inputOf({ ...draft, minNoticeHours: '' })).toEqual({ invalid: 'minNoticeHours' });
  });

  it('reads a saved type back into the same input', () => {
    const saved: EventType = {
      id: '00000000-0000-7000-8000-0000000000aa',
      slug: 'tu-van',
      title: 'Tư vấn',
      description: 'Gọi',
      durationMin: 45,
      bufferBeforeMin: 5,
      bufferAfterMin: 10,
      minNoticeMin: 120,
      horizonDays: 30,
      dailyLimit: 3,
      locationKind: 'phone',
      locationValue: '0901234567',
      hostUserId: OTHER,
      active: true,
      createdAt: '2026-10-24T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z',
    };
    const { id: _id, active: _active, createdAt: _c, updatedAt: _u, ...input } = saved;
    expect(inputOf(draftOf(saved, ME))).toEqual({ input });
  });

  it('offers owners and admins every member who may host, a member only themselves', () => {
    expect(hostChoices(members, ME, true).map((m) => m.userId)).toEqual([ME, OTHER]);
    expect(hostChoices(members, ME, false).map((m) => m.userId)).toEqual([ME]);
    const type = { hostUserId: OTHER } as EventType;
    expect(mayManage(type, ME, false)).toBe(false);
    expect(mayManage(type, ME, true)).toBe(true);
    expect(mayManage({ hostUserId: ME } as EventType, ME, false)).toBe(true);
  });
});
