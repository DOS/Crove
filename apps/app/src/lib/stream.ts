// Realtime invalidation (issue #69, plan §9). The kernel's /api/stream sends ids of changed records, never their
// data; this tab marks the matching queries stale and TanStack Query re-fetches the visible ones through the normal
// authorized calls. While the stream is down the screens poll as before. No browser or API imports, so it is unit
// tested; stream-hook.ts wires it to EventSource and the query client.
import type { Query, QueryClient } from '@tanstack/react-query';
import { STREAM_CLOSE_REASONS, STREAM_HINT_TYPES, type StreamCloseReason, type StreamHint } from '@crove/kernel-contract';

// oRPC query keys are [path, { type, input }], for example [['inbox', 'get'], { type: 'query', input: { id } }].
function pathOf(query: Query): string {
  const path = query.queryKey[0];
  return Array.isArray(path) ? path.join('.') : '';
}

function inputId(query: Query): unknown {
  const options = query.queryKey[1] as { input?: { id?: unknown } } | undefined;
  return options?.input?.id;
}

interface InboxDetailData {
  file?: { id?: unknown } | null;
  result?: { documentId?: unknown; voidedDocumentId?: unknown; journalEntryId?: unknown; reversedEntryId?: unknown } | null;
}

function detail(query: Query): InboxDetailData | undefined {
  return query.state.data as InboxDetailData | undefined;
}

// Which cached queries a hint makes stale. Lists of the hint's kind, and the detail of that very record (by the id in
// its key, or the record it shows).
export function hintMatches(hint: StreamHint, query: Query): boolean {
  const path = pathOf(query);
  const { id } = hint;
  switch (hint.type) {
    case 'proposal':
      return path === 'inbox.list' || path === 'files.recent' || (path === 'inbox.get' && inputId(query) === id);
    case 'file':
    case 'extraction':
      // extraction carries the id of the file whose reading changed.
      return path === 'files.recent' || path === 'inbox.list' || (path === 'inbox.get' && detail(query)?.file?.id === id);
    case 'journal_entry': {
      // The ledger reports (#321) read every posted entry, so any new one changes them. A voucher (#327) is posted, and
      // shown as reversed, with an entry.
      if (path === 'journal.list' || path === 'documents.list' || path === 'ledger.period' || path === 'ledger.account' || path === 'vouchers.list') return true;
      if (path === 'journal.get') return inputId(query) === id;
      const result = detail(query)?.result;
      return path === 'inbox.get' && (result?.journalEntryId === id || result?.reversedEntryId === id);
    }
    case 'document': {
      if (path === 'documents.list' || path === 'parties.list') return true;
      const result = detail(query)?.result;
      return path === 'inbox.get' && (result?.documentId === id || result?.voidedDocumentId === id);
    }
    case 'social_post': {
      // The calendar, that post, and the queues whose free slots a schedule change moves.
      if (path === 'social.posts.list' || path === 'social.queues.get') return true;
      const options = query.queryKey[1] as { input?: { postId?: unknown } } | undefined;
      return path === 'social.posts.get' && options?.input?.postId === id;
    }
    // A notification written or read (#637), of anyone in the org: the bell reads its own again.
    case 'social_notification':
      return path === 'social.notifications.list';
  }
}

export function invalidateHint(queryClient: QueryClient, hint: StreamHint): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (query) => hintMatches(hint, query) });
}

const TYPES: ReadonlySet<string> = new Set(STREAM_HINT_TYPES);
const REASONS: ReadonlySet<string> = new Set(STREAM_CLOSE_REASONS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseHintEvent(data: string): StreamHint | null {
  try {
    const value = JSON.parse(data) as { type?: unknown; id?: unknown };
    if (typeof value.type !== 'string' || !TYPES.has(value.type) || typeof value.id !== 'string' || !UUID.test(value.id)) return null;
    return { type: value.type as StreamHint['type'], id: value.id };
  } catch {
    return null;
  }
}

export function parseCloseEvent(data: string): StreamCloseReason {
  try {
    const reason = (JSON.parse(data) as { reason?: unknown }).reason;
    return typeof reason === 'string' && REASONS.has(reason) ? (reason as StreamCloseReason) : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// Reasons that mean this tab's access changed: the app re-checks it with a normal call (which signs out, leaves the
// org or asks for MFA) instead of reconnecting at once.
export function accessEnded(reason: StreamCloseReason): boolean {
  return reason === 'session' || reason === 'session_revoked_in_org' || reason === 'mfa' || reason === 'membership';
}

// What the stream client needs from EventSource.
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
}

export interface StreamClientDeps {
  // A one-time ticket (POST /api/stream/tickets). Throws { status } on refusal; 404 means streams are off.
  ticket: () => Promise<string>;
  open: (url: string) => EventSourceLike;
  hint: (hint: StreamHint) => void;
  // Refresh everything of the org: after a reconnect (hints may have been missed) or when the server says so.
  resync: () => void;
  // The server closed for an access reason (accessEnded).
  accessChanged: (reason: StreamCloseReason) => void;
  // true while hints flow, so the screens can stop polling.
  live: (live: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
  // 0 to 1; backoff delays are scaled into [50%, 100%] so tabs that lost a stream together do not return together.
  random?: () => number;
  clearTimer?: (handle: unknown) => void;
}

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
// After an access reason the app re-checks with a normal call first; the stream comes back later if access holds.
export const ACCESS_RETRY_MS = 60_000;
// A stream that stayed up this long resets the backoff; one that keeps ending sooner (whatever the reason) backs off.
export const STABLE_MS = 30_000;

// Connects, and reconnects with backoff, until the returned function stops it. EventSource's own reconnect would reuse
// the spent ticket, so every error closes it and a new ticket opens the next one.
export function startStreamClient(deps: StreamClientDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let stopped = false;
  let source: EventSourceLike | null = null;
  let timer: unknown = null;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  let failures = 0;
  let connectedBefore = false;
  let readyAt: number | null = null;

  const drop = () => {
    source?.close();
    source = null;
    if (readyAt !== null && now() - readyAt >= STABLE_MS) failures = 0;
    readyAt = null;
    deps.live(false);
  };

  const retry = (ms: number) => {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void connect();
    }, ms);
  };

  const backoff = () => {
    failures++;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(failures - 1, 10));
    retry(Math.round(delay * (0.5 + random() / 2)));
  };

  const connect = async () => {
    if (stopped) return;
    let ticket: string;
    try {
      ticket = await deps.ticket();
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      // Streams are off on this deployment: keep polling.
      if (status === 404) return;
      // Not signed in, not a member: the screens' own calls handle that; try again much later.
      if (status === 401 || status === 403) retry(ACCESS_RETRY_MS);
      else backoff();
      return;
    }
    if (stopped) return;
    const es = deps.open(`/api/stream?ticket=${encodeURIComponent(ticket)}`);
    source = es;
    es.addEventListener('ready', () => {
      if (source !== es) return;
      readyAt = now();
      deps.live(true);
      if (connectedBefore) deps.resync();
      connectedBefore = true;
    });
    es.addEventListener('invalidate', (event) => {
      if (source !== es) return;
      const hint = parseHintEvent(event.data ?? '');
      if (hint) deps.hint(hint);
    });
    es.addEventListener('resync', () => {
      if (source === es) deps.resync();
    });
    es.addEventListener('close', (event) => {
      if (source !== es) return;
      const reason = parseCloseEvent(event.data ?? '');
      drop();
      if (accessEnded(reason)) {
        deps.accessChanged(reason);
        retry(ACCESS_RETRY_MS);
      } else {
        // expired: the next ticket comes with a fresh token; unavailable and shutdown: another instance, or later.
        backoff();
      }
    });
    es.onerror = () => {
      if (source !== es) return;
      drop();
      backoff();
    };
  };

  void connect();
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    drop();
  };
}
