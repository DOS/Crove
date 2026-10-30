// The event types card's helpers (issue #1314): the form to the saved input and back, the slug that follows the
// title, and who may host or manage; team types (#1373) with their co-hosts.
import { describe, expect, it } from 'vitest';
import { slugOf, type EventType } from '@crove/kernel-contract';
import { coHostChoices, draftOf, EVENT_TYPE_CHECKED_FIELDS, eventTypeFieldInvalid, hostChoices, inputOf, mayManage, withCoHost, withHost, withTitle, type EventTypeMember } from '../src/lib/event-types.ts';

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
        assignment: 'single',
        coHostUserIds: [],
      },
    });
    expect(inputOf({ ...draft, durationMin: '30.5' })).toEqual({ invalid: 'durationMin' });
    expect(inputOf({ ...draft, dailyLimit: 'x' })).toEqual({ invalid: 'dailyLimit' });
    expect(inputOf({ ...draft, minNoticeHours: '' })).toEqual({ invalid: 'minNoticeHours' });
  });

  it('marks each field on its own, so every error sits under its field (#2004)', () => {
    const draft = { ...withTitle(draftOf(null, ME), 'Tư vấn'), durationMin: '30.5', minNoticeHours: '-1', dailyLimit: 'x', assignment: 'collective' as const, coHostUserIds: [] };
    expect(EVENT_TYPE_CHECKED_FIELDS.filter((field) => eventTypeFieldInvalid(draft, field))).toEqual(['durationMin', 'minNoticeHours', 'dailyLimit', 'coHostUserIds']);
    expect(inputOf(draft)).toEqual({ invalid: 'durationMin' });
    const fine = { ...draft, durationMin: '30', minNoticeHours: '0,5', dailyLimit: '', assignment: 'single' as const };
    expect(EVENT_TYPE_CHECKED_FIELDS.filter((field) => eventTypeFieldInvalid(fine, field))).toEqual([]);
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
      assignment: 'round_robin',
      coHostUserIds: [ME],
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

  it('keeps a team type to co-hosts who are neither the lead nor viewers, and needs one', () => {
    expect(coHostChoices(members, ME).map((m) => m.userId)).toEqual([OTHER]);
    const single = withTitle(draftOf(null, ME), 'Nhóm');
    const team = { ...single, assignment: 'collective' as const };
    expect(inputOf(team)).toEqual({ invalid: 'coHostUserIds' });
    const withOther = withCoHost(team, OTHER, true);
    expect(withOther.coHostUserIds).toEqual([OTHER]);
    expect(withCoHost(withOther, ME, true).coHostUserIds).toEqual([OTHER]);
    expect(withCoHost(withOther, OTHER, false).coHostUserIds).toEqual([]);
    // A co-host made the lead leaves the co-hosts.
    expect(withHost(withOther, OTHER)).toMatchObject({ hostUserId: OTHER, coHostUserIds: [] });
    // Back to a single host: the co-hosts are not sent.
    const back = inputOf({ ...withOther, assignment: 'single' });
    expect('input' in back && back.input.coHostUserIds).toEqual([]);
  });
});
