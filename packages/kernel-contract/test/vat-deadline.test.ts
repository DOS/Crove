// VAT return deadlines for the multi-client home screen (issue #318).
import { describe, expect, it } from 'vitest';
import { nextVatDeadline } from '../src/index.ts';

describe('nextVatDeadline, monthly returns', () => {
  it('is the 20th of the month after the period while that day has not passed', () => {
    // 2026-10-20 is a Tuesday.
    expect(nextVatDeadline('month', '2026-10-01')).toEqual({ period: '2026-09', dueDate: '2026-10-20', daysLeft: 19 });
    expect(nextVatDeadline('month', '2026-10-19')).toEqual({ period: '2026-09', dueDate: '2026-10-20', daysLeft: 1 });
    expect(nextVatDeadline('month', '2026-10-20')).toEqual({ period: '2026-09', dueDate: '2026-10-20', daysLeft: 0 });
  });

  it("moves on to the current month's return the day after", () => {
    // 2026-11-20 is a Friday.
    expect(nextVatDeadline('month', '2026-10-21')).toEqual({ period: '2026-10', dueDate: '2026-11-20', daysLeft: 30 });
  });

  it('moves a deadline on a Saturday or a Sunday to the Monday', () => {
    // 2026-12-20 is a Sunday; 2027-03-20 a Saturday.
    expect(nextVatDeadline('month', '2026-12-05')).toEqual({ period: '2026-11', dueDate: '2026-12-21', daysLeft: 16 });
    expect(nextVatDeadline('month', '2027-03-20')).toEqual({ period: '2027-02', dueDate: '2027-03-22', daysLeft: 2 });
    // The weekend in between still counts as before the deadline.
    expect(nextVatDeadline('month', '2027-03-21')).toEqual({ period: '2027-02', dueDate: '2027-03-22', daysLeft: 1 });
    expect(nextVatDeadline('month', '2027-03-23')).toEqual({ period: '2027-03', dueDate: '2027-04-20', daysLeft: 28 });
  });

  it('crosses the year', () => {
    // 2027-01-20 is a Wednesday.
    expect(nextVatDeadline('month', '2026-12-31')).toEqual({ period: '2026-12', dueDate: '2027-01-20', daysLeft: 20 });
    expect(nextVatDeadline('month', '2027-01-02')).toEqual({ period: '2026-12', dueDate: '2027-01-20', daysLeft: 18 });
  });
});

describe('nextVatDeadline, quarterly returns', () => {
  it('is the last day of the first month of the next quarter', () => {
    // 2026-07-31 is a Friday.
    expect(nextVatDeadline('quarter', '2026-07-01')).toEqual({ period: '2026-Q2', dueDate: '2026-07-31', daysLeft: 30 });
    expect(nextVatDeadline('quarter', '2026-07-31')).toEqual({ period: '2026-Q2', dueDate: '2026-07-31', daysLeft: 0 });
  });

  it("moves on to the current quarter's return once it has passed", () => {
    // 2026-10-31 is a Saturday, so the Q3 return is due on Monday 2026-11-02.
    expect(nextVatDeadline('quarter', '2026-08-01')).toEqual({ period: '2026-Q3', dueDate: '2026-11-02', daysLeft: 93 });
    expect(nextVatDeadline('quarter', '2026-10-19')).toEqual({ period: '2026-Q3', dueDate: '2026-11-02', daysLeft: 14 });
    expect(nextVatDeadline('quarter', '2026-11-02')).toEqual({ period: '2026-Q3', dueDate: '2026-11-02', daysLeft: 0 });
  });

  it('crosses the year for the fourth quarter', () => {
    // 2027-01-31 is a Sunday.
    expect(nextVatDeadline('quarter', '2026-11-03')).toEqual({ period: '2026-Q4', dueDate: '2027-02-01', daysLeft: 90 });
    expect(nextVatDeadline('quarter', '2027-01-15')).toEqual({ period: '2026-Q4', dueDate: '2027-02-01', daysLeft: 17 });
    expect(nextVatDeadline('quarter', '2027-02-02')).toEqual({ period: '2027-Q1', dueDate: '2027-04-30', daysLeft: 87 });
  });

  it('refuses a date that is not a calendar date', () => {
    expect(() => nextVatDeadline('quarter', '2026-02-30')).toThrow();
    expect(() => nextVatDeadline('month', '19/10/2026')).toThrow();
  });
});
