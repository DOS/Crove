// The public side of link-in-bio pages (#707): PUBLIC_URL/b/<slug> is drawn here as plain HTML from the page's definer
// (no script, no third party, every text escaped), its links go out through /b/<slug>/go/<target> (counted, the link
// read from the database, never from the request), and its images come from /b/<slug>/img/<file> (only the avatar
// and the images of the posts the page shows). Each runs a definer on the control plane as the API login role.
import { sql } from 'kysely';
import { readVerified, type BlobStore, type Runtime } from '@crove/kernel-runtime';

export const BIO_HITS_PER_MINUTE = 120;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const TARGET = /^(button:[0-9]{1,2}|post:[0-9a-f-]{36})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The largest image the page sends (a post image is at most 10 MB in the library).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Link previews and crawlers fetch a link without a person behind them: they follow it, uncounted. Only their own
// signatures: an app's in-app browser (Zalo, Telegram) is a person and counts. TelegramBot and Discordbot match 'bot';
// WhatsApp's preview fetcher names itself WhatsApp/<version>.
const AUTOMATED = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|whatsapp\/|curl|wget|python|okhttp/i;

export const BIO_PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface BioView {
  title: string;
  about: string | null;
  avatar: boolean;
  avatarId: string | null;
  buttons: { label: string }[];
  posts: { postId: string; fileId: string; excerpt: string | null; linked: boolean }[];
}

export async function bioView(runtime: Runtime, slug: string): Promise<BioView | null> {
  if (!SLUG.test(slug)) return null;
  return runtime.orgless(async (db) => {
    const { rows } = await sql<{ page: BioView | null }>`SELECT crove_social.bio_page_view(${slug}) AS page`.execute(db);
    return rows[0]?.page ?? null;
  });
}

// The link behind a button or a shown post, counted unless the visitor is automated; null for anything else.
export async function bioGo(runtime: Runtime, slug: string, target: string, userAgent: string | undefined): Promise<string | null> {
  if (!SLUG.test(slug) || !TARGET.test(target)) return null;
  const count = Boolean(userAgent) && !AUTOMATED.test(userAgent as string);
  const url = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ url: string | null }>`SELECT crove_social.bio_page_go(${slug}, ${target}, ${count}) AS url`.execute(db);
    return rows[0]?.url ?? null;
  });
  return url && /^https?:\/\//.test(url) ? url : null;
}

// An image the page shows, read as stored and checked against its hash; null for any other file.
export async function bioImage(runtime: Runtime, store: BlobStore, slug: string, fileId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!SLUG.test(slug) || !UUID.test(fileId)) return null;
  const file = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ storage_key: string; generation: string | null; sha256: string; content_type: string; size_bytes: string }>`
      SELECT storage_key, generation, sha256, content_type, size_bytes FROM crove_social.bio_page_file(${slug}, ${fileId}::uuid)`.execute(db);
    return rows[0] ?? null;
  });
  if (!file || Number(file.size_bytes) > MAX_IMAGE_BYTES) return null;
  const bytes = await readVerified(store, { key: file.storage_key, generation: file.generation, sha256: file.sha256 });
  return { bytes, contentType: file.content_type };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function renderBioPage(slug: string, view: BioView): string {
  const base = `/b/${slug}`;
  const buttons = view.buttons.map((b, i) => `<a class="button" href="${base}/go/button:${i}" rel="noopener">${escape(b.label)}</a>`).join('\n');
  const posts = view.posts
    .filter((p) => UUID.test(p.fileId) && UUID.test(p.postId))
    .map((p) => {
      const img = `<img src="${base}/img/${p.fileId}" alt="${escape(p.excerpt ?? '')}" loading="lazy">`;
      return p.linked ? `<a class="post" href="${base}/go/post:${p.postId}" rel="noopener">${img}</a>` : `<span class="post">${img}</span>`;
    })
    .join('\n');
  const avatar = view.avatar && view.avatarId && UUID.test(view.avatarId) ? `<img class="avatar" src="${base}/img/${view.avatarId}" alt="">` : '';
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(view.title)}</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #52525b; --card: #ffffff; --line: #e4e4e7; }
@media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; --card: #18181b; --line: #27272a; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); }
main { max-width: 32rem; margin: 0 auto; padding: 2.5rem 1rem 3rem; text-align: center; }
.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; border: 1px solid var(--line); }
h1 { font-size: 1.375rem; margin: 0.75rem 0 0.25rem; }
p.about { color: var(--muted); margin: 0 0 1.5rem; white-space: pre-line; }
.button { display: block; margin: 0.625rem 0; padding: 0.875rem 1rem; border: 1px solid var(--line); border-radius: 0.75rem; background: var(--card); color: var(--fg); text-decoration: none; font-weight: 600; }
.button:hover { border-color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.25rem; margin-top: 1.5rem; }
.post { display: block; aspect-ratio: 1; overflow: hidden; border-radius: 0.375rem; background: var(--line); }
.post img { width: 100%; height: 100%; object-fit: cover; display: block; }
footer { margin-top: 2rem; font-size: 0.75rem; color: var(--muted); }
</style>
</head>
<body>
<main>
${avatar}
<h1>${escape(view.title)}</h1>
${view.about ? `<p class="about">${escape(view.about)}</p>` : ''}
${buttons}
${posts ? `<div class="grid">\n${posts}\n</div>` : ''}
<footer>Crove</footer>
</main>
</body>
</html>`;
}
