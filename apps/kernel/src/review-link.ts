// The public side of client review links (#589): the review page sends the link's token and gets the post as each
// channel shows it, or records the client's answer. Both run the migration's definers on the control plane as the
// API login role; the token is the only credential, and nothing else of the org comes back.
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError, readVerified, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import type { PageBrand } from './report-link.ts';

export const REVIEW_VIEWS_PER_MINUTE = 60;
export const REVIEW_ANSWERS_PER_MINUTE = 10;
// The post's files on the review page (#624): a page of five images asks five times, so its own, larger budget.
export const REVIEW_FILES_PER_MINUTE = 120;
// The largest file the page gets through the API when the store hands out no download URL (local disk): a whole
// file is read to check its hash, so a larger video shows as a count, as before.
export const REVIEW_FILE_MAX_BYTES = 25 * 1024 * 1024;

const zToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const zView = z.strictObject({ token: zToken });
const zFile = z.strictObject({ token: zToken, fileId: z.string().uuid() });
// No NUL: PostgreSQL text cannot hold it, and it would end as a server error rather than a refusal.
const zText = (max: number) => z.string().trim().max(max).refine((s) => !s.includes('\u0000'), 'NUL is not allowed');
const zAnswer = z.strictObject({
  token: zToken,
  // The post answered on a plan link (#902); a single-post link's answer names none.
  postId: z.string().uuid().optional(),
  name: zText(100).pipe(z.string().min(1)),
  verdict: z.enum(['approved', 'changes_requested', 'comment']),
  body: zText(2000).optional(),
});

// signature (#1190): the variant's signature, sent after the body, or null; the page appends it as effectiveContent does.
type ReviewChannel = { provider: string; channel: string; status: string; body: string; signature: string | null; title: string | null; linkUrl: string | null };
// reply (#1301): the team's reply under the answer, which the page signs with the org's name, or null.
type ReviewAnswer = { name: string; verdict: string; body: string | null; at: string; reply: { body: string; at: string } | null };
export interface ReviewPostPage {
  kind?: undefined;
  org: string;
  // The org's white-label branding (#1053), or null.
  brand: PageBrand | null;
  expiresAt: string;
  changed: boolean;
  channels: (ReviewChannel & { mediaCount: number })[];
  feedback: ReviewAnswer[];
}
// A plan link's page (#902): its posts in schedule order, each with its files' ids, or only gone when cancelled since.
// Each post's body comes once (#930): a channel's body is null when it shows the post's body.
export interface ReviewPlanPage {
  kind: 'plan';
  org: string;
  brand: PageBrand | null;
  expiresAt: string;
  from: string | null;
  to: string | null;
  posts: (
    | { id: string; gone: true }
    | {
        id: string;
        gone: false;
        at: string | null;
        changed: boolean;
        body: string | null;
        channels: (Omit<ReviewChannel, 'body'> & { body: string | null; media: { id: string; type: string }[] })[];
        answers: number;
        feedback: ReviewAnswer[];
      }
  )[];
}
export type ReviewPage = ReviewPostPage | ReviewPlanPage;

// null: a malformed body, or a token that names no live link (the same answer either way).
export async function reviewView(runtime: Runtime, body: unknown): Promise<ReviewPage | null> {
  const input = zView.safeParse(body);
  if (!input.success) return null;
  return runtime.orgless(async (db) => {
    const { rows } = await sql<{ page: ReviewPage | null }>`SELECT crove_social.review_link_view(${input.data.token}) AS page`.execute(db);
    return rows[0]?.page ?? null;
  });
}

// Each channel's files on a live link (ids and types), in the order of the view's channels; null otherwise.
export async function reviewMedia(runtime: Runtime, body: unknown): Promise<{ id: string; type: string }[][] | null> {
  const input = zView.safeParse(body);
  if (!input.success) return null;
  return runtime.orgless(async (db) => {
    const { rows } = await sql<{ media: { id: string; type: string }[][] | null }>`SELECT crove_social.review_link_media(${input.data.token}) AS media`.execute(db);
    return rows[0]?.media ?? null;
  });
}

export type ReviewFile = { url: string } | { bytes: Uint8Array; type: string; filename: string };

// One file a channel of the link's post shows: a short-lived download URL where the store makes one, else its bytes
// (checked against the recorded sha256). null: a malformed body, a dead link, or a file the post does not show.
export async function reviewFile(
  runtime: Runtime,
  store: Pick<BlobStore, 'get' | 'direct'>,
  body: unknown,
): Promise<ReviewFile | null> {
  const input = zFile.safeParse(body);
  if (!input.success) return null;
  const meta = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ file: { key: string; generation: string | null; sha256: string; type: string; size: string | number; filename: string } | null }>`SELECT crove_social.review_link_file(${input.data.token}, ${input.data.fileId}::uuid) AS file`.execute(db);
    return rows[0]?.file ?? null;
  });
  if (!meta) return null;
  const ref = { key: meta.key, generation: meta.generation, sha256: meta.sha256 };
  const url = store.direct ? await store.direct.presignDownload(ref, { filename: meta.filename, contentType: meta.type }) : null;
  if (url) return { url };
  if (Number(meta.size) > REVIEW_FILE_MAX_BYTES) throw new DomainError('TOO_LARGE', 413, 'Tệp này quá lớn để xem trên trang duyệt');
  return { bytes: await readVerified(store as BlobStore, ref), type: meta.type, filename: meta.filename };
}

export async function reviewAnswer(runtime: Runtime, body: unknown): Promise<{ recorded: true } | null> {
  const parsed = zAnswer.safeParse(body);
  if (!parsed.success) {
    if (typeof body === 'object' && body !== null && zToken.safeParse((body as { token?: unknown }).token).success) {
      throw new DomainError('REVIEW_ANSWER_INVALID', 422, 'Hãy nhập tên của bạn; một bình luận cần có nội dung');
    }
    return null;
  }
  const { token, postId, name, verdict } = parsed.data;
  const text = parsed.data.body ? parsed.data.body : null;
  if (verdict === 'comment' && !text) throw new DomainError('REVIEW_ANSWER_INVALID', 422, 'Hãy nhập tên của bạn; một bình luận cần có nội dung');
  return runtime.orgless(async (db) => {
    try {
      const { rows } = postId
        ? await sql<{ done: { recorded: true } | null }>`SELECT crove_social.review_plan_feedback_add(${token}, ${postId}::uuid, ${name}, ${verdict}, ${text}) AS done`.execute(db)
        : await sql<{ done: { recorded: true } | null }>`SELECT crove_social.review_feedback_add(${token}, ${name}, ${verdict}, ${text}) AS done`.execute(db);
      return rows[0]?.done ?? null;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === '54000') throw new DomainError('REVIEW_ANSWER_LIMIT', 429, 'Liên kết này đã nhận đủ số ý kiến tối đa');
      if (code === '55000') throw new DomainError('REVIEW_POST_GONE', 409, 'Bài này không còn trong kế hoạch');
      if (code === '22023' || code === '22021' || code === '22P05') throw new DomainError('REVIEW_ANSWER_INVALID', 422, 'Hãy nhập tên của bạn; một bình luận cần có nội dung');
      throw error;
    }
  });
}
