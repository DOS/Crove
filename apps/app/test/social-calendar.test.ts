import { describe, expect, it } from 'vitest';
import {
  calendarGroups,
  calendarItems,
  DAY_MS,
  dayId,
  DROP_HOURS,
  followsPlan,
  groupDrop,
  groupMovable,
  groupsByDay,
  groupStatuses,
  localMoment,
  notesByDay,
  onDay,
  planDrop,
  plannedAt,
  runGroupMove,
  SLOT_RANGE_DAYS,
  slotDrop,
  slotRange,
  slotsByDay,
  slotVariant,
  startOfWeek,
  viewDays,
  type CalendarGroup,
  type CalendarItem,
} from '../src/lib/social-calendar.ts';

type Post = Parameters<typeof calendarItems>[0][number];

const variant = (id: string, status: string, effectiveAt: string | null) => ({ id, status, effectiveAt }) as unknown as Post['variants'][number];
const post = (scheduledAt: string | null, variants: Post['variants']) => ({ id: 'p', scheduledAt, variants }) as unknown as Post;

describe('Social calendar (#580)', () => {
  it('starts weeks on Monday and shows six weeks for a month', () => {
    const wednesday = new Date(2026, 9, 21, 15, 30);
    expect(dayId(startOfWeek(wednesday))).toBe('2026-10-19');
    const month = viewDays('month', new Date(2026, 9, 20));
    expect([month.length, dayId(month[0] as Date), dayId(month.at(-1) as Date)]).toEqual([42, '2026-09-28', '2026-11-08']);
    expect(viewDays('week', wednesday).map(dayId)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  });

  it('keeps the time of day when a channel moves to another day', () => {
    const moved = onDay(new Date(2026, 9, 21, 9, 45), new Date(2026, 9, 24));
    expect([dayId(moved), moved.getHours(), moved.getMinutes()]).toEqual(['2026-10-24', 9, 45]);
  });

  it('places scheduled channels at their time, drafts at the planned time, and leaves out cancelled ones', () => {
    const items = calendarItems([
      post('2026-10-25T02:00:00.000Z', [
        variant('a', 'scheduled', '2026-10-22T02:00:00.000Z'),
        variant('b', 'draft', '2026-10-25T02:00:00.000Z'),
        variant('c', 'cancelled', '2026-10-23T02:00:00.000Z'),
      ]),
      post(null, [variant('d', 'in_review', null)]),
    ]);
    expect(items.map((i) => [i.v.id, i.at.toISOString(), i.planned])).toEqual([
      ['a', '2026-10-22T02:00:00.000Z', false],
      ['b', '2026-10-25T02:00:00.000Z', true],
    ]);
  });
  it('plans an undated draft at 09:00, or today at the next full hour, and never in the past (#1145)', () => {
    const morning = new Date(2026, 9, 21, 7, 30);
    const afternoon = new Date(2026, 9, 21, 14, 10);
    const late = new Date(2026, 9, 21, 23, 20);
    const at = (d: Date | null) => (d ? [dayId(d), d.getHours(), d.getMinutes()] : null);
    // A later day: 09:00. Today before 09:00: 09:00; after it: the next full hour; after 23:00: nothing left today.
    expect(at(plannedAt(new Date(2026, 9, 24), afternoon))).toEqual(['2026-10-24', 9, 0]);
    expect(at(plannedAt(new Date(2026, 9, 21), morning))).toEqual(['2026-10-21', 9, 0]);
    expect(at(plannedAt(new Date(2026, 9, 21), afternoon))).toEqual(['2026-10-21', 15, 0]);
    expect(plannedAt(new Date(2026, 9, 21), late)).toBeNull();
    expect(plannedAt(new Date(2026, 9, 20), morning)).toBeNull();
    // An hour from the week view: that hour, if it is still ahead.
    expect(at(plannedAt(new Date(2026, 9, 21), afternoon, 18))).toEqual(['2026-10-21', 18, 0]);
    expect(plannedAt(new Date(2026, 9, 21), afternoon, 14)).toBeNull();
    expect(DROP_HOURS[0]).toBe(6);
    expect(DROP_HOURS.at(-1)).toBe(23);
  });

  it('asks social.post.update once per drop, with the revision shown, and refuses a time gone (#1145)', () => {
    const now = new Date(2026, 9, 21, 14, 10);
    const undated = { post: { id: 'p', revision: 3 }, at: null };
    expect(planDrop(undated, new Date(2026, 9, 24), now)).toEqual({ postId: 'p', revision: 3, scheduledAt: new Date(2026, 9, 24, 9, 0).toISOString() });
    expect(planDrop(undated, new Date(2026, 9, 20), now)).toBe('past');
    expect(planDrop(undated, new Date(2026, 9, 24), now, 20)).toEqual({ postId: 'p', revision: 3, scheduledAt: new Date(2026, 9, 24, 20, 0).toISOString() });
    // A planned draft keeps its time of day, or takes the hour dropped on with its minutes; the same time sends nothing.
    const planned = { post: { id: 'q', revision: 7 }, at: new Date(2026, 9, 22, 10, 45) };
    expect(planDrop(planned, new Date(2026, 9, 25), now)).toEqual({ postId: 'q', revision: 7, scheduledAt: new Date(2026, 9, 25, 10, 45).toISOString() });
    expect(planDrop(planned, new Date(2026, 9, 22), now, 16)).toEqual({ postId: 'q', revision: 7, scheduledAt: new Date(2026, 9, 22, 16, 45).toISOString() });
    expect(planDrop(planned, new Date(2026, 9, 22), now)).toBeNull();
    // Today at 10:45 has passed.
    expect(planDrop(planned, new Date(2026, 9, 21), now)).toBe('past');
  });

  it('moves a draft only when it sits at its post’s planned time, and reads the editor’s date and time (#1145)', () => {
    const [follows, own] = calendarItems([
      post('2026-10-25T02:00:00.000Z', [variant('a', 'draft', '2026-10-25T02:00:00.000Z'), variant('b', 'in_review', '2026-10-26T02:00:00.000Z')]),
    ]);
    expect([followsPlan(follows as CalendarItem), followsPlan(own as CalendarItem)]).toEqual([true, false]);
    const [scheduled] = calendarItems([post('2026-10-25T02:00:00.000Z', [variant('c', 'scheduled', '2026-10-25T02:00:00.000Z')])]);
    expect(followsPlan(scheduled as CalendarItem)).toBe(false);
    const moment = localMoment('2026-10-24', '08:30');
    expect(moment && [dayId(moment), moment.getHours(), moment.getMinutes()]).toEqual(['2026-10-24', 8, 30]);
    expect([localMoment('', '08:30'), localMoment('2026-10-24', '')]).toEqual([null, null]);
  });

it('puts a note on every day it covers, both ends included (#794)', () => {
    const days = viewDays('week', new Date(2026, 9, 21));
    const byDay = notesByDay([{ id: 'sale', startsOn: '2026-10-20', endsOn: '2026-10-22' }, { id: 'later', startsOn: '2026-11-01', endsOn: '2026-11-01' }], days);
    expect([...byDay.keys()]).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
    expect(byDay.get('2026-10-21')?.map((n) => n.id)).toEqual(['sale']);
  });
});
describe('open queue slots on the Social calendar (#1158)', () => {
  const ch = (id: string, status: string, connectionId: string, extra: Record<string, unknown> = {}) => ({ id, status, connectionId, effectiveAt: null, queueSlotAt: null, queuePaused: false, ...extra }) as unknown as Post['variants'][number];
  const full = (variants: Post['variants'], extra: Record<string, unknown> = {}) => ({ id: 'p', revision: 4, scheduledAt: null, labelIds: [], variants, ...extra }) as unknown as Post;
  const slot = (at: Date, labelId: string | null = null) => ({ at: at.toISOString(), labelId, label: labelId ? 'Khuyến mãi' : null });
  const now = new Date(2026, 9, 21, 14, 10);
  const owner = { canDecide: true, canWrite: true };
  const member = { canDecide: false, canWrite: true };

  it('draws only the filtered channel of a post (#1044)', () => {
    const posts = [full([ch('a', 'scheduled', 'A', { effectiveAt: '2026-10-22T02:00:00.000Z' }), ch('b', 'scheduled', 'B', { effectiveAt: '2026-10-22T02:00:00.000Z' })])];
    expect(calendarItems(posts).map((i) => i.v.id)).toEqual(['a', 'b']);
    expect(calendarItems(posts, 'B').map((i) => i.v.id)).toEqual(['b']);
  });

  it('asks for what the view shows from now on, at most 31 days', () => {
    const iso = (d: Date) => d.toISOString();
    // This month: from now to the end of the six weeks shown, cut at 31 days.
    expect(slotRange('month', viewDays('month', now), now, now)).toEqual({ from: iso(now), to: iso(new Date(2026, 10, 9)) });
    const early = new Date(2026, 9, 1, 0, 30);
    expect(slotRange('month', viewDays('month', early), early, early)).toEqual({ from: iso(early), to: iso(new Date(early.getTime() + SLOT_RANGE_DAYS * DAY_MS)) });
    // A later month: from its 1st, so all its days fit.
    const december = new Date(2026, 11, 1);
    const range = slotRange('month', viewDays('month', december), december, now);
    expect(range?.from).toBe(iso(december));
    expect(Date.parse(range?.to as string)).toBeGreaterThanOrEqual(new Date(2027, 0, 1).getTime());
    // A week: its seven days, from now when it is this week; a past week asks nothing.
    const week = viewDays('week', now);
    expect(slotRange('week', week, now, now)).toEqual({ from: iso(now), to: iso(new Date(2026, 9, 26)) });
    expect(slotRange('week', viewDays('week', new Date(2026, 9, 7)), new Date(2026, 9, 7), now)).toBeNull();
    const byDay = slotsByDay([slot(new Date(2026, 9, 22, 9)), slot(new Date(2026, 9, 22, 20)), slot(new Date(2026, 9, 24, 9))]);
    expect([...byDay.keys()]).toEqual(['2026-10-22', '2026-10-24']);
    expect(byDay.get('2026-10-22')).toHaveLength(2);
  });

  it('schedules an approved or scheduled channel of the queue into the slot, for owners and admins', () => {
    const at = new Date(2026, 9, 22, 19);
    const approved = full([ch('v', 'approved', 'A'), ch('w', 'draft', 'B')]);
    // An undated draft with an approved channel there: that channel goes into the slot.
    expect(slotDrop({ post: approved, item: null }, slot(at), 'A', owner, now)).toEqual({ kind: 'schedule', postId: 'p', variantId: 'v', slotAt: at.toISOString() });
    // A scheduled chip moves there; one already in that slot, or held by a paused queue, does not.
    const [scheduled] = calendarItems([full([ch('s', 'scheduled', 'A', { effectiveAt: '2026-10-23T02:00:00.000Z', queueSlotAt: '2026-10-23T02:00:00.000Z' })])]);
    const target = { post: (scheduled as CalendarItem).post, item: scheduled as CalendarItem };
    expect(slotDrop(target, slot(at), 'A', owner, now)).toMatchObject({ kind: 'schedule', variantId: 's' });
    expect(slotDrop(target, slot(new Date('2026-10-23T02:00:00.000Z')), 'A', owner, now)).toBeNull();
    const [held] = calendarItems([full([ch('h', 'scheduled', 'A', { effectiveAt: '2026-10-23T02:00:00.000Z', queuePaused: true })])]);
    expect(slotVariant({ post: (held as CalendarItem).post, item: held as CalendarItem }, 'A')).toBeNull();
    // A slot kept for a label the post lacks, or a time gone, is refused with nothing sent.
    expect(slotDrop({ post: approved, item: null }, slot(at, 'promo'), 'A', owner, now)).toBe('label');
    expect(slotDrop({ post: full([ch('v', 'approved', 'A')], { labelIds: ['promo'] }), item: null }, slot(at, 'promo'), 'A', owner, now)).toMatchObject({ kind: 'schedule' });
    expect(slotDrop({ post: approved, item: null }, slot(new Date(2026, 9, 21, 9)), 'A', owner, now)).toBe('past');
  });

  it('plans a draft at the slot’s time otherwise, as a drop on a day does (#1145)', () => {
    const at = new Date(2026, 9, 22, 19);
    const draft = full([ch('d', 'draft', 'A')]);
    const plan = { kind: 'plan', request: { postId: 'p', revision: 4, scheduledAt: at.toISOString() } };
    expect(slotDrop({ post: draft, item: null }, slot(at), 'A', member, now)).toEqual(plan);
    expect(slotDrop({ post: draft, item: null }, slot(at), 'A', owner, now)).toEqual(plan);
    // A member does not schedule an approved channel; the draft's planned time takes the slot instead.
    expect(slotDrop({ post: full([ch('v', 'approved', 'A')]), item: null }, slot(at), 'A', member, now)).toEqual(plan);
    // A planned draft at its post's time moves there; a viewer, or a draft with a time of its own, does nothing.
    const [planned] = calendarItems([full([ch('d', 'draft', 'A', { effectiveAt: '2026-10-25T02:00:00.000Z' })], { scheduledAt: '2026-10-25T02:00:00.000Z' })]);
    expect(slotDrop({ post: (planned as CalendarItem).post, item: planned as CalendarItem }, slot(at), 'A', member, now)).toEqual(plan);
    expect(slotDrop({ post: draft, item: null }, slot(at), 'A', { canDecide: false, canWrite: false }, now)).toBeNull();
    const [own] = calendarItems([full([ch('r', 'in_review', 'A', { effectiveAt: '2026-10-26T02:00:00.000Z' })], { scheduledAt: '2026-10-25T02:00:00.000Z' })]);
    expect(slotDrop({ post: (own as CalendarItem).post, item: own as CalendarItem }, slot(at), 'A', member, now)).toBeNull();
  });
});
describe('one calendar chip per post (#1220)', () => {
  const ch = (id: string, status: string, connectionId: string, extra: Record<string, unknown> = {}) =>
    ({ id, status, connectionId, provider: 'sandbox', effectiveAt: null, queueSlotAt: null, queuePaused: false, error: null, ...extra }) as unknown as Post['variants'][number];
  const full = (id: string, variants: Post['variants'], extra: Record<string, unknown> = {}) => ({ id, revision: 4, scheduledAt: null, labelIds: [], variants, ...extra }) as unknown as Post;
  const owner = { canDecide: true, canWrite: true };
  const member = { canDecide: false, canWrite: true };
  // Local times, so the day arithmetic holds in any zone the tests run in.
  const at = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 9, day, hour, minute, second).toISOString();
  const now = new Date(2026, 9, 21, 14, 10);

  it('makes one chip of a post’s channels at the same minute, and one per minute otherwise', () => {
    const six = full('six', ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ch(id, 'scheduled', id.toUpperCase(), { effectiveAt: at(22, 9, 0, i) })));
    const split = full('split', [ch('g', 'scheduled', 'A', { effectiveAt: at(22, 9) }), ch('h', 'scheduled', 'B', { effectiveAt: at(22, 10) })]);
    const other = full('other', [ch('i', 'scheduled', 'A', { effectiveAt: at(22, 9, 30) })]);
    const groups = calendarGroups(calendarItems([six, split, other]));
    expect(groups.map((g) => [g.post.id, g.items.map((i) => i.v.id).join('')])).toEqual([
      ['six', 'abcdef'],
      ['split', 'g'],
      ['other', 'i'],
      ['split', 'h'],
    ]);
    // A day of twelve posts holds twelve chips, whatever their channels.
    const twelve = Array.from({ length: 12 }, (_, n) => full(`p${n}`, [ch(`v${n}`, 'scheduled', 'A', { effectiveAt: at(23, 8 + n) }), ch(`w${n}`, 'scheduled', 'B', { effectiveAt: at(23, 8 + n) })]));
    const byDay = groupsByDay(calendarGroups(calendarItems(twelve)));
    expect(byDay.get('2026-10-23')).toHaveLength(12);
  });

  it('is dashed only when every channel is a draft at the planned time, and names the statuses in words', () => {
    const mixed = full('m', [ch('a', 'draft', 'A', { effectiveAt: at(25, 9) }), ch('b', 'failed', 'B', { effectiveAt: at(25, 9) }), ch('c', 'scheduled', 'C', { effectiveAt: at(25, 9) }), ch('d', 'scheduled', 'D', { effectiveAt: at(25, 9) })], {
      scheduledAt: at(25, 9),
    });
    const [group] = calendarGroups(calendarItems([mixed]));
    expect(group?.items).toHaveLength(4);
    expect(group?.planned).toBe(false);
    // What needs a person comes first.
    expect(groupStatuses(group as CalendarGroup)).toEqual([
      { key: 'failed', count: 1 },
      { key: 'draft', count: 1 },
      { key: 'scheduled', count: 2 },
    ]);
    const [drafts] = calendarGroups(calendarItems([full('d', [ch('a', 'draft', 'A', { effectiveAt: at(25, 9) }), ch('b', 'in_review', 'B', { effectiveAt: at(25, 9) })], { scheduledAt: at(25, 9) })]));
    expect(drafts?.planned).toBe(true);
  });

  it('moves the scheduled channels with the time shown and the drafts through the planned time, naming those that stay', () => {
    const post = full(
      'p',
      [
        ch('s1', 'scheduled', 'A', { effectiveAt: at(22, 9) }),
        ch('s2', 'scheduled', 'B', { effectiveAt: at(22, 9), queueSlotAt: at(22, 9) }),
        ch('held', 'scheduled', 'C', { effectiveAt: at(22, 9), queueSlotAt: at(22, 9), queuePaused: true }),
        ch('d', 'draft', 'D', { effectiveAt: at(22, 9) }),
        ch('out', 'published', 'E', { effectiveAt: at(22, 9) }),
        // Sent back to review with a time of its own, in the same minute.
        ch('own', 'in_review', 'F', { effectiveAt: at(22, 9, 0, 30) }),
      ],
      { scheduledAt: at(22, 9) },
    );
    const [group] = calendarGroups(calendarItems([post]));
    const g = group as CalendarGroup;
    expect(g.items).toHaveLength(6);
    const move = groupDrop(g, new Date(2026, 9, 24), now, owner);
    if (move === null || move === 'past') throw new Error('expected a move');
    expect(move.at.toISOString()).toBe(at(24, 9));
    expect(move.reschedules.map((r) => r.request)).toEqual([
      { variantId: 's1', at: at(24, 9), expectedAt: at(22, 9) },
      { variantId: 's2', at: at(24, 9), expectedAt: at(22, 9) },
    ]);
    // The draft at the post's planned time moves with the post; a channel with a time of its own in review does not.
    expect(move.plan).toEqual({ request: { postId: 'p', revision: 4, scheduledAt: at(24, 9) }, items: [g.items[3]] });
    expect(move.stayed.map((s) => `${s.item.v.id}:${s.reason}`)).toEqual(['held:queuePaused', 'out:out', 'own:notScheduled']);
    // A member moves the draft; the scheduled channels stay, said to be for owners and admins.
    const byMember = groupDrop(g, new Date(2026, 9, 24), now, member, 16);
    if (byMember === null || byMember === 'past') throw new Error('expected a move');
    expect(byMember.reschedules).toEqual([]);
    expect(byMember.plan?.request.scheduledAt).toBe(at(24, 16));
    expect(byMember.stayed.map((s) => `${s.item.v.id}:${s.reason}`)).toEqual(['s1:admins', 's2:admins', 'held:queuePaused', 'out:out', 'own:notScheduled']);
  });

  it('refuses a time gone, sends nothing for the same minute, and is not draggable with nothing to move', () => {
    const [scheduled] = calendarGroups(calendarItems([full('p', [ch('s', 'scheduled', 'A', { effectiveAt: at(21, 9, 0, 30) })])]));
    const g = scheduled as CalendarGroup;
    // Today at 09:00 is gone; the same day and minute (the seconds aside) changes nothing.
    expect(groupDrop(g, new Date(2026, 9, 21), new Date(2026, 9, 20, 8), owner)).toBeNull();
    expect(groupDrop({ ...g, at: new Date(at(22, 9)) }, new Date(2026, 9, 21), now, owner)).toBe('past');
    expect(groupMovable(g, owner)).toBe(true);
    expect(groupMovable(g, member)).toBe(false);
    expect(groupDrop(g, new Date(2026, 9, 24), now, member)).toBeNull();
    const [published] = calendarGroups(calendarItems([full('q', [ch('o', 'published', 'A', { effectiveAt: at(20, 9) })])]));
    expect(groupMovable(published as CalendarGroup, owner)).toBe(false);
  });

  it('goes on after a refusal, then plans the drafts, and keeps each refusal for the result', async () => {
    const post = full('p', [ch('a', 'scheduled', 'A', { effectiveAt: at(22, 9) }), ch('b', 'scheduled', 'B', { effectiveAt: at(22, 9) }), ch('d', 'draft', 'D', { effectiveAt: at(22, 9) })], { scheduledAt: at(22, 9) });
    const [group] = calendarGroups(calendarItems([post]));
    const move = groupDrop(group as CalendarGroup, new Date(2026, 9, 24), now, owner);
    if (move === null || move === 'past') throw new Error('expected a move');
    const sent: string[] = [];
    const stale = Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
    const result = await runGroupMove(move, {
      reschedule: async (r) => {
        sent.push(`reschedule:${r.variantId}`);
        if (r.variantId === 'a') throw stale;
      },
      plan: async (r) => {
        sent.push(`plan:${r.postId}`);
      },
    });
    expect(sent).toEqual(['reschedule:a', 'reschedule:b', 'plan:p']);
    expect(result.moved.map((i) => i.v.id)).toEqual(['b', 'd']);
    expect(result.refused).toEqual([{ item: (group as CalendarGroup).items[0], error: stale }]);
    // A refused plan names each of its drafts.
    const refusedPlan = await runGroupMove(move, { reschedule: async () => undefined, plan: async () => Promise.reject(stale) });
    expect(refusedPlan.refused.map((x) => x.item.v.id)).toEqual(['d']);
  });
});
