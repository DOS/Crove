// The public side of client review links (#589): the review page sends the link's token and gets the post as each
// channel shows it, or records the client's answer. Both run the migration's definers on the control plane as the
// API login role; the token is the only credential, and nothing else of the org comes back.
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

export const REVIEW_VIEWS_PER_MINUTE = 60;
export const REVIEW_ANSWERS_PER_MINUTE = 10;

const zToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const zView = z.strictObject({ token: zToken });
const zAnswer = z.strictObject({
  token: zToken,
  name: z.string().trim().min(1).max(100),
  verdict: z.enum(['approved', 'changes_requested', 'comment']),
  body: z.string().trim().max(2000).optional(),
});

export interface ReviewPage {
  org: string;
  expiresAt: string;
  changed: boolean;
  channels: { provider: string; channel: string; status: string; body: string; title: string | null; linkUrl: string | null; mediaCount: number }[];
  feedback: { name: string; verdict: string; body: string | null; at: string }[];
}

// null: a malformed body, or a token that names no live link (the same answer either way).
export async function reviewView(runtime: Runtime, body: unknown): Promise<ReviewPage | null> {
  const input = zView.safeParse(body);
  if (!input.success) return null;
  return runtime.orgless(async (db) => {
    const { rows } = await sql<{ page: ReviewPage | null }>`SELECT crove_social.review_link_view(${input.data.token}) AS page`.execute(db);
    return rows[0]?.page ?? null;
  });
}

export async function reviewAnswer(runtime: Runtime, body: unknown): Promise<{ recorded: true } | null> {
  const parsed = zAnswer.safeParse(body);
  if (!parsed.success) {
    if (typeof body === 'object' && body !== null && zToken.safeParse((body as { token?: unknown }).token).success) {
      throw new DomainError('REVIEW_ANSWER_INVALID', 422, 'Hãy nhập tên của bạn; một bình luận cần có nội dung');
    }
    return null;
  }
  const { token, name, verdict } = parsed.data;
  const text = parsed.data.body ? parsed.data.body : null;
  if (verdict === 'comment' && !text) throw new DomainError('REVIEW_ANSWER_INVALID', 422, 'Hãy nhập tên của bạn; một bình luận cần có nội dung');
  return runtime.orgless(async (db) => {
    try {
      const { rows } = await sql<{ done: { recorded: true } | null }>`SELECT crove_social.review_feedback_add(${token}, ${name}, ${verdict}, ${text}) AS done`.execute(db);
      return rows[0]?.done ?? null;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === '54000') throw new DomainError('REVIEW_ANSWER_LIMIT', 429, 'Liên kết này đã nhận đủ số ý kiến tối đa');
      if (code === '22023') throw new DomainError('REVIEW_ANSWER_INVALID', 422, 'Hãy nhập tên của bạn; một bình luận cần có nội dung');
      throw error;
    }
  });
}
