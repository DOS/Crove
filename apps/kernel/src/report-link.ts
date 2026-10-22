// The public side of client report links (#643): the report page sends the link's token and gets the report of its
// period. It runs the migration's definer on the control plane as the API login role; the token is the only
// credential, and nothing else of the org comes back.
import { sql } from 'kysely';
import { z } from 'zod';
import type { Runtime } from '@crove/kernel-runtime';

export const REPORT_VIEWS_PER_MINUTE = 60;

const zView = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

// The org's white-label branding (#1053), or null: a display name, the logo as an inline PNG, WebP or JPEG data URL,
// an accent colour (#rrggbb) and whether to show no "Crove". Only the link's own org's.
export interface PageBrand {
  name: string | null;
  logo: string | null;
  accent: string | null;
  hideCrove: boolean;
}

export interface ReportPage {
  org: string;
  brand: PageBrand | null;
  title: string | null;
  periodStart: string;
  periodEnd: string;
  expiresAt: string;
  posts: number;
  totals: Record<string, number>;
  // The period of the same length just before (#947), on the same channels; in each channel, its counts then.
  previous: { periodStart: string; periodEnd: string; posts: number; totals: Record<string, number> };
  channels: { channel: string; provider: string; posts: number; totals: Record<string, number>; previous: { posts: number; totals: Record<string, number> } }[];
  // external (#1054): the post went out outside Crove; includesExternal: the link counts such posts.
  top: { channel: string; provider: string; excerpt: string; publishedAt: string; url: string | null; metrics: Record<string, number>; external?: boolean }[];
  includesExternal?: boolean;
  // The agency's note (#1056), plain text, or null.
  note: string | null;
  // The monthly goals (#1056), only for a period of exactly one month in the goals' zone; null otherwise.
  goals: {
    month: string;
    timeZone: string;
    groups: { channel: string | null; provider: string | null; items: { metric: string; target: number; actual: number | null }[] }[];
  } | null;
}

// null: a malformed body, or a token that names no live link (the same answer either way).
export async function reportView(runtime: Runtime, body: unknown): Promise<ReportPage | null> {
  const input = zView.safeParse(body);
  if (!input.success) return null;
  return runtime.orgless(async (db) => {
    const { rows } = await sql<{ page: ReportPage | null }>`SELECT crove_social.report_link_view(${input.data.token}) AS page`.execute(db);
    return rows[0]?.page ?? null;
  });
}
