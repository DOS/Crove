// The team report's pure parts (#1058): the median the query takes of review times, and the CSV file the app saves.
import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/metrics.ts';
import { csvCell as sharedCsvCell } from '../src/domain/csv.ts';
import { TEAM_CSV_COLUMNS, hoursOf, medianOrNull, teamReportCsv, type TeamMemberRow, type TeamReport } from '../src/domain/team-report.ts';

const member = (over: Partial<TeamMemberRow> = {}): TeamMemberRow => ({
  userId: '11111111-1111-4111-8111-111111111111',
  name: 'Lan',
  left: false,
  created: 0,
  submitted: 0,
  approved: 0,
  published: 0,
  assigned: 0,
  overdue: 0,
  decisions: 0,
  decisionSeconds: null,
  ...over,
});

const report = (members: TeamMemberRow[], client: Partial<TeamReport['client']> = {}): TeamReport => ({
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-10-01T00:00:00.000Z',
  members,
  client: { answers: 0, approved: 0, changesRequested: 0, medianSeconds: null, ...client },
});

const lines = (csv: string) => csv.replace(/^\uFEFF/, '').split('\r\n');

describe('team report median (#1058)', () => {
  it('is the middle value, or the mean of the two middle ones, whatever the order', () => {
    expect(medianOrNull([7200, 14_400, 3600])).toBe(7200);
    expect(medianOrNull([21_600, 10_800])).toBe(16_200);
    expect(medianOrNull([5])).toBe(5);
    expect(medianOrNull([3, 1, 2, 4])).toBe(2.5);
  });

  it('is null without values, not zero', () => {
    expect(medianOrNull([])).toBeNull();
  });

  it('writes hours with at most two decimals', () => {
    expect(hoursOf(7200)).toBe('2');
    expect(hoursOf(16_200)).toBe('4.5');
    expect(hoursOf(4800)).toBe('1.33');
    expect(hoursOf(null)).toBeNull();
  });
});

describe('team report CSV (#1058)', () => {
  it('starts with a byte order mark and the header, then a line per member and the client line', () => {
    const csv = teamReportCsv(
      report(
        [
          member({ created: 3, submitted: 3, approved: 3, published: 2, assigned: 1, overdue: 1, decisions: 0 }),
          member({ userId: '22222222-2222-4222-8222-222222222222', name: null, left: true, created: 1, submitted: 1, approved: 1, assigned: 1 }),
          member({ userId: '33333333-3333-4333-8333-333333333333', name: 'Minh', decisions: 3, decisionSeconds: 7200 }),
        ],
        { answers: 3, approved: 2, changesRequested: 1, medianSeconds: 21_600 },
      ),
      'Khách hàng (liên kết duyệt)',
    );
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines(csv)).toEqual([
      TEAM_CSV_COLUMNS.join(','),
      'Lan,member,3,3,3,2,1,1,0,,11111111-1111-4111-8111-111111111111',
      ',left,1,1,1,0,1,0,0,,22222222-2222-4222-8222-222222222222',
      'Minh,member,0,0,0,0,0,0,3,2,33333333-3333-4333-8333-333333333333',
      'Khách hàng (liên kết duyệt),client,,,2,,,,3,6,',
      '',
    ]);
  });

  it('quotes names as every Social export does, so a spreadsheet never runs one as a formula', () => {
    const csv = teamReportCsv(report([member({ name: '=HYPERLINK("x")' }), member({ userId: '44444444-4444-4444-8444-444444444444', name: 'Trần, Bình' })]));
    expect(lines(csv)[1]?.startsWith(`"'=HYPERLINK(""x"")",member`)).toBe(true);
    expect(lines(csv)[2]?.startsWith('"Trần, Bình",member')).toBe(true);
    expect(lines(csv)[3]).toBe('Client review links,client,,,0,,,,0,,');
  });

  it('shares one quoting rule with the metrics and plan exports', () => {
    expect(csvCell).toBe(sharedCsvCell);
  });
});
