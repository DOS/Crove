// The team report (#1058): what each member did in a period and how long reviews took, as social.team.report returns
// it, with the pure parts the query and the app share: the median and the CSV file. Isomorphic (the contract exports
// it), so the app writes the file from the rows it shows, with the same quoting as every Social export.
import { csvCell } from './csv.ts';
import { median } from './insights.ts';

// The longest period one report covers, and the slack for days picked in a zone with daylight saving.
export const TEAM_REPORT_MAX_DAYS = 366;
export const TEAM_REPORT_DST_SLACK_MS = 2 * 3_600_000;

export interface TeamMemberRow {
  userId: string;
  // The member's name while they are a member (crove_kernel.member_profiles); null once they left.
  name: string | null;
  left: boolean;
  // Posts they wrote that were created in the period.
  created: number;
  // Posts they sent to review in the period (each post once).
  submitted: number;
  // Posts they wrote that a reviewer approved in the period (each post once).
  approved: number;
  // Posts they wrote with a channel published in the period (each post once).
  published: number;
  // Posts assigned to them with a due date in the period, and those of them overdue: the due date has passed and no
  // channel went out by it (a cancelled post is neither).
  assigned: number;
  overdue: number;
  // Review decisions they made in the period (one per post and decision, whatever the channels), and the median time
  // from the post's submission to the decision, in seconds; null without decisions.
  decisions: number;
  decisionSeconds: number | null;
}

export interface TeamClientSummary {
  // Clients' first answer per link and post in the period ("Approved" or "Needs changes"; comments are no answer).
  answers: number;
  approved: number;
  changesRequested: number;
  // The median time from the link's creation to that answer, in seconds; null without answers.
  medianSeconds: number | null;
}

export interface TeamReport {
  from: string;
  to: string;
  members: TeamMemberRow[];
  client: TeamClientSummary;
}

// The median of some numbers (the insights' median: the middle one, or the mean of the two middle ones), or null for
// none rather than 0, since a member without reviews took no time. Order-independent.
export function medianOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : median(values);
}

// Seconds as hours with at most two decimals, for the file.
export function hoursOf(seconds: number | null): string | null {
  return seconds === null ? null : String(Math.round(seconds / 36) / 100);
}

export const TEAM_CSV_COLUMNS = [
  'member',
  'status',
  'posts_created',
  'sent_to_review',
  'approved',
  'published',
  'assigned_due',
  'overdue',
  'review_decisions',
  'median_review_hours',
  'user_id',
] as const;

// The report as a CSV file: a byte order mark (so a spreadsheet opens Vietnamese names as UTF-8), the header, a line
// per member (status member or left; a member who left has no name), then one line for the client review links
// (status client) with their answers and median time to answer. clientLabel names that line in the reader's language.
export function teamReportCsv(report: TeamReport, clientLabel = 'Client review links'): string {
  const lines = report.members.map((m) =>
    [m.name, m.left ? 'left' : 'member', m.created, m.submitted, m.approved, m.published, m.assigned, m.overdue, m.decisions, hoursOf(m.decisionSeconds), m.userId].map(csvCell).join(','),
  );
  const c = report.client;
  lines.push([clientLabel, 'client', null, null, c.approved, null, null, null, c.answers, hoursOf(c.medianSeconds), null].map(csvCell).join(','));
  return `﻿${[TEAM_CSV_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`;
}
