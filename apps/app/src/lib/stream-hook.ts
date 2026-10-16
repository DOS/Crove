// Wires the invalidation stream (lib/stream.ts) to EventSource and the query client for the org on screen.
import { useEffect, useSyncExternalStore } from 'react';
import { fetchStreamTicket, queryClient } from './api.ts';
import { getConfig } from './auth.ts';
import { invalidateHint, startStreamClient, type EventSourceLike } from './stream.ts';

let live = false;
const listeners = new Set<() => void>();

function setLive(value: boolean): void {
  if (live === value) return;
  live = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// true while hints arrive: screens then poll only as a slow safety net.
export function useStreamLive(): boolean {
  return useSyncExternalStore(subscribe, () => live, () => false);
}

// While hints arrive, lists still refresh this often: rows deleted by retention send no hint.
export const SAFETY_POLL_MS = 120_000;

// The interval a polling query uses: `fallback` while the stream is down, `whileLive` (default: no polling) while
// hints arrive.
export function pollEvery(streamLive: boolean, fallback: number, whileLive: number | false = false): number | false {
  return streamLive ? whileLive : fallback;
}

// One stream per org layout; it follows the org in the URL and stops when the layout unmounts.
export function useInvalidationStream(slug: string): void {
  useEffect(() => {
    if (!getConfig().stream || typeof EventSource === 'undefined') return;
    const stop = startStreamClient({
      ticket: () => fetchStreamTicket(slug),
      open: (url) => new EventSource(url) as unknown as EventSourceLike,
      hint: (hint) => void invalidateHint(queryClient, hint),
      resync: () => void queryClient.invalidateQueries(),
      // A normal call then signs out, leaves the org or asks for MFA (the query cache's error handler).
      accessChanged: () => void queryClient.invalidateQueries(),
      live: setLive,
    });
    return () => {
      stop();
      setLive(false);
    };
  }, [slug]);
}
