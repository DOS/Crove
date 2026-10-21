import { describe, expect, it } from 'vitest';
import { PLAN_CSV_COLUMNS, planCsv, planTime, type PlanRow } from '../src/plan-export.ts';

const row = (over: Partial<PlanRow> = {}): PlanRow => ({
  postId: 'p1',
  variantId: 'v1',
  connectionId: 'c1',
  channel: 'Quán A',
  provider: 'facebook_page',
  status: 'scheduled',
  at: '2026-11-01T02:00:00.000Z',
  title: null,
  body: 'Khai trương chi nhánh Quận 3',
  linkUrl: null,
  labels: [],
  assignee: null,
  ...over,
});

describe('content plan CSV (#978)', () => {
  it("starts with the import template's columns, in its names, then the plan's own", () => {
    expect(PLAN_CSV_COLUMNS.slice(0, 5)).toEqual(['text', 'title', 'link', 'channels', 'time']);
    const csv = planCsv([row()], 'Asia/Ho_Chi_Minh');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual(['text,title,link,channels,time,status,labels,assignee,post_id', 'Khai trương chi nhánh Quận 3,,,Quán A,2026-11-01 09:00,scheduled,,,p1', '']);
  });

  it('writes times as the import reads them, local to the zone asked for', () => {
    expect(planTime('2026-11-01T02:00:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('2026-11-01 09:00');
    expect(planTime('2026-11-01T02:00:00.000Z', 'America/New_York')).toBe('2026-10-31 22:00');
    // After the clocks go back in New York (1 November 2026).
    expect(planTime('2026-11-02T14:05:00.000Z', 'America/New_York')).toBe('2026-11-02 09:05');
    expect(planTime('2026-11-01T02:00:00.000Z', 'UTC')).toBe('2026-11-01 02:00');
  });

  it('quotes, joins the labels and keeps a spreadsheet from running a cell as a formula', () => {
    const line = planCsv(
      [row({ body: '=HYPERLINK("x")', title: '- Giảm 20%, tuần đầu', linkUrl: 'https://example.test/a', labels: ['Khai trương', 'Tết'], assignee: '@Lan', channel: '+Kênh' })],
      'Asia/Ho_Chi_Minh',
    )
      .slice(1)
      .split('\r\n')[1];
    expect(line).toBe(`"'=HYPERLINK(""x"")","'- Giảm 20%, tuần đầu",https://example.test/a,'+Kênh,2026-11-01 09:00,scheduled,"Khai trương, Tết",'@Lan,p1`);
  });

  it('keeps line breaks of a text inside one quoted cell', () => {
    const lines = planCsv([row({ body: 'Dòng một\nDòng hai' })], 'UTC').slice(1).split('\r\n');
    expect(lines[1]).toBe('"Dòng một\nDòng hai",,,Quán A,2026-11-01 02:00,scheduled,,,p1');
  });
});
