// The public side of Social short links (#706): GET /l/<code> redirects to the link the post went out with and counts
// the click. It runs the migration's definer on the control plane as the API login role; the code is all it takes,
// the target comes from the database and never from the request, and nothing of the visitor is kept.
import { sql } from 'kysely';
import type { Runtime } from '@crove/kernel-runtime';

export const SHORT_LINK_HITS_PER_MINUTE = 120;
const CODE = /^[A-Za-z0-9]{10,16}$/;
// Link previews and crawlers fetch a link without a person behind them: they follow it, uncounted.
const AUTOMATED = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|zalo|whatsapp|telegram|discord|curl|wget|python|okhttp/i;

export const isAutomated = (userAgent: string | undefined) => !userAgent || AUTOMATED.test(userAgent);

// The target of a live code (an active org's link), or null; counted unless the visitor is automated.
export async function shortLinkTarget(runtime: Runtime, code: string, userAgent: string | undefined): Promise<string | null> {
  if (!CODE.test(code)) return null;
  const target = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ target: string | null }>`SELECT crove_social.short_link_hit(${code}, ${!isAutomated(userAgent)}) AS target`.execute(db);
    return rows[0]?.target ?? null;
  });
  // Only a web link leaves through the redirect, whatever the row holds (the table checks it too).
  return target && /^https?:\/\//.test(target) ? target : null;
}
