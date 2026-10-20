// The worker's side of link preview cards (#641): fetch the page of a requested link through the egress guard, read
// its head in crove-extract (the kernel parses no HTML), and record what it said or why it could not be read. A
// failure of the extract service itself is thrown, so the job is retried; anything the page causes is recorded.
import { EXTRACT_LIMITS, type ExtractClient } from '@crove/extract-contract';
import { EgressError, guardedFetch, type Runtime } from '@crove/kernel-runtime';

export const LINK_PREVIEW_TIMEOUT_MS = 8000;
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

type Result = { ok: true; title: string | null; description: string | null; siteName: string | null } | { ok: false; error: 'http' | 'not_html' | EgressError['code'] };

export interface LinkPreviewDeps {
  runtime: Runtime;
  extract: ExtractClient;
  // Tests only.
  fetch?: typeof guardedFetch;
}

export async function runLinkPreviewJob(deps: LinkPreviewDeps, orgId: string, previewId: string): Promise<'ready' | 'failed' | 'none'> {
  const actor = { type: 'system' as const, component: 'social.link_preview' };
  const target = await deps.runtime.query<{ url: string } | null>('social.link_preview.load', { previewId }, { actor, orgId });
  if (!target) return 'none';
  const record = async (result: Result) => {
    await deps.runtime.execute('social.link_preview.record', { previewId, result }, { actor, orgId });
    return result.ok ? ('ready' as const) : ('failed' as const);
  };
  let page;
  try {
    page = await (deps.fetch ?? guardedFetch)(target.url, {
      timeoutMs: LINK_PREVIEW_TIMEOUT_MS,
      maxBytes: EXTRACT_LIMITS.maxHtmlBytes,
      // The head is at the start; a long page is cut, not refused.
      overLimit: 'truncate',
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
    });
  } catch (error) {
    if (error instanceof EgressError) return record({ ok: false, error: error.code });
    throw error;
  }
  if (page.status < 200 || page.status >= 300) return record({ ok: false, error: 'http' });
  const type = (page.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type !== '' && !HTML_TYPES.has(type)) return record({ ok: false, error: 'not_html' });
  const read = await deps.extract.extract('html_meta', page.body);
  if (!read.ok) {
    // Caused by the page: recorded. Caused by the service: retried.
    if (read.code === 'invalid' || read.code === 'too_large' || read.code === 'timeout' || read.code === 'memory') return record({ ok: false, error: 'not_html' });
    throw new Error(`crove-extract: ${read.code}`);
  }
  return record({ ok: true, ...read.page });
}
