// Pinned internal comments (#1180): a comment on a spot of one of the post's images or a moment of one of its videos,
// as designers and reviewers say "the logo here" or "the text at 0:12". The board shows the post's images and videos
// (and each channel's own) whole, with a numbered marker for each open pinned comment; a marker, and the list of pins
// under each file, scroll to its comment. A member clicks a spot on an image, or pauses a video and pins the moment,
// before writing the comment; from the keyboard, Enter on an image pins its middle and the arrow keys move the pin
// before it is saved (#1186). A resolved comment's marker goes away; a pin on a file the post no longer uses shows in
// its comment, on an earlier image, with that file's thumbnail.
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { cn } from '@crove/ui/lib/utils';
import { scrollBehavior } from '../lib/media.ts';
import { useImageUrl } from './social-media.tsx';
import { Spinner } from './ui.tsx';

// A file the board shows: the post's own (variantId null), or a channel's own media.
export interface PinMedia {
  fileId: string;
  mime: string;
  altText: string;
  durationMs?: number | null | undefined;
  variantId: string | null;
  // The channel's name, for a channel's own file.
  channel?: string | null | undefined;
}

export interface Pin {
  fileId: string;
  mime: string;
  filename: string;
  x: number | null;
  y: number | null;
  atSeconds: number | null;
  current: boolean;
}

// A pin chosen for the comment being written; variantId: the channel whose own file it is (null: the post's).
export type DraftPin = { fileId: string; variantId: string | null } & ({ x: number; y: number } | { atSeconds: number });

// An open pinned comment on the board, with its number.
export interface BoardPin {
  commentId: string;
  n: number;
  body: string;
  pin: Pin;
}

export const isPinnable = (mime: string) => mime.startsWith('image/') || mime.startsWith('video/');

// m:ss of a moment in a video.
export const clockOf = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// The open pinned comments on files the board shows, numbered from the oldest; resolved ones are left out (their
// marker is hidden), as are pins on a file the post no longer uses.
export function boardPins(items: readonly { id: string; kind: string; at: string; body: string | null; resolvedAt: string | null; pin?: Pin | null }[], shown: ReadonlySet<string>): BoardPin[] {
  return items
    .filter((i): i is typeof i & { pin: Pin } => i.kind === 'comment' && i.resolvedAt === null && !!i.pin && i.pin.current && shown.has(i.pin.fileId))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .map((i, k) => ({ commentId: i.id, n: k + 1, body: i.body ?? '', pin: i.pin }));
}

// A spot on an image, x and y in 0..1 from the top left, kept on the image and to the precision the server stores.
const clampSpot = (v: number) => Math.min(1, Math.max(0, Math.round(v * 10000) / 10000));

// How far an arrow key moves a pin not saved yet (#1186, WCAG 2.5.7): 1% of the image, 10% with Shift.
export const PIN_STEP = 0.01;
export const PIN_STEP_LARGE = 0.1;
const ARROWS: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

// Where an arrow key moves a pin, kept on the image; null for any other key, or with Ctrl, Alt or Meta (the browser's
// and the system's shortcuts).
export function nudgePin(at: { x: number; y: number }, key: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): { x: number; y: number } | null {
  if (key.ctrlKey || key.altKey || key.metaKey || !Object.hasOwn(ARROWS, key.key)) return null;
  const [dx, dy] = ARROWS[key.key] as readonly [number, number];
  const step = key.shiftKey ? PIN_STEP_LARGE : PIN_STEP;
  return { x: clampSpot(at.x + dx * step), y: clampSpot(at.y + dy * step) };
}

export const commentAnchor = (commentId: string) => `comment-${commentId}`;
export const markerAnchor = (commentId: string) => `pin-${commentId}`;

// Brings an element into view and gives it the focus, for a marker and its comment.
function reveal(id: string) {
  const el = typeof document === 'undefined' ? null : document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  el.focus({ preventScroll: true });
}
export const revealComment = (commentId: string) => reveal(commentAnchor(commentId));
export const revealMarker = (commentId: string) => reveal(markerAnchor(commentId));

// A comment's text without its mention tokens, short, for a marker's label.
const excerpt = (body: string) => {
  const plain = body.replace(/<@[0-9a-f-]{36}>/g, '@').replace(/\s+/g, ' ').trim();
  return plain.length > 60 ? `${plain.slice(0, 57)}...` : plain;
};

function Marker({ pin, onClick, label, className, style }: { pin: BoardPin | null; onClick?: () => void; label: string; className?: string; style?: React.CSSProperties }) {
  return (
    <button
      type="button"
      id={pin ? markerAnchor(pin.commentId) : undefined}
      aria-label={label}
      title={label}
      onClick={onClick}
      style={style}
      // The pin not saved yet does nothing when pressed: out of the tab order, so Tab goes on to the comment box.
      tabIndex={pin ? undefined : -1}
      data-testid={pin ? 'pin-marker' : 'pin-draft'}
      className={cn(
        'absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-background text-xs font-semibold shadow-md ring-offset-2 ring-offset-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        pin ? 'bg-primary text-primary-foreground' : 'bg-warning text-foreground',
        className,
      )}
    >
      {pin ? pin.n : '+'}
    </button>
  );
}

function ImageBoard({ item, label, pins, draft, onDraft, canPin }: { item: PinMedia; label: string; pins: BoardPin[]; draft: DraftPin | null; onDraft: (pin: DraftPin) => void; canPin: boolean }) {
  const t = useTranslations('social.activity');
  const url = useImageUrl(item.fileId);
  const mine = draft && draft.fileId === item.fileId && draft.variantId === item.variantId && 'x' in draft ? draft : null;
  const image = url.url ? <img src={url.url} alt={item.altText || label} className="block h-auto w-full" draggable={false} /> : <div className="flex aspect-[4/3] items-center justify-center">{url.isLoading ? <Spinner /> : null}</div>;
  return (
    <div className="relative overflow-hidden rounded-lg border bg-muted">
      {canPin ? (
        <button
          type="button"
          className="block w-full cursor-crosshair ring-offset-2 ring-offset-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={t('pinImage', { media: label })}
          disabled={!url.url}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            // From the keyboard (no pointer position) the pin goes to the middle, and the arrow keys move it from there.
            const keyboard = e.detail === 0 || rect.width === 0 || rect.height === 0;
            onDraft({ fileId: item.fileId, variantId: item.variantId, x: keyboard ? 0.5 : clampSpot((e.clientX - rect.left) / rect.width), y: keyboard ? 0.5 : clampSpot((e.clientY - rect.top) / rect.height) });
          }}
          onKeyDown={(e) => {
            const moved = mine ? nudgePin(mine, e) : null;
            if (!mine || !moved) return;
            e.preventDefault();
            onDraft({ ...mine, ...moved });
          }}
        >
          {image}
        </button>
      ) : (
        image
      )}
      {/* Where the pin not saved yet is, read out as the arrow keys move it. */}
      {canPin && (
        <span className="sr-only" aria-live="polite" data-testid="pin-draft-at">
          {mine ? t('draftAt', { x: Math.round(mine.x * 100), y: Math.round(mine.y * 100) }) : ''}
        </span>
      )}
      {pins.map((p) => (
        <Marker key={p.commentId} pin={p} label={t('marker', { n: String(p.n), text: excerpt(p.body) })} onClick={() => revealComment(p.commentId)} style={{ left: `${(p.pin.x ?? 0) * 100}%`, top: `${(p.pin.y ?? 0) * 100}%` }} />
      ))}
      {mine && <Marker pin={null} label={t('draftMarker')} className="pointer-events-none" style={{ left: `${mine.x * 100}%`, top: `${mine.y * 100}%` }} />}
    </div>
  );
}

function VideoBoard({ item, label, pins, draft, onDraft, canPin }: { item: PinMedia; label: string; pins: BoardPin[]; draft: DraftPin | null; onDraft: (pin: DraftPin) => void; canPin: boolean }) {
  const t = useTranslations('social.activity');
  const url = useImageUrl(item.fileId);
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState(item.durationMs ? item.durationMs / 1000 : 0);
  const mine = draft && draft.fileId === item.fileId && draft.variantId === item.variantId && 'atSeconds' in draft ? draft : null;
  const seek = (s: number) => {
    if (video.current) video.current.currentTime = s;
  };
  const at = (s: number) => (duration > 0 ? `${Math.min(100, (s / duration) * 100)}%` : '0%');
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border bg-muted">
        {url.url ? (
          <video
            ref={video}
            src={url.url}
            controls
            playsInline
            preload="metadata"
            aria-label={item.altText || label}
            className="block h-auto w-full"
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
          />
        ) : (
          <div className="flex aspect-video items-center justify-center">{url.isLoading ? <Spinner /> : null}</div>
        )}
      </div>
      {/* The moments, on a line as long as the video. */}
      {(pins.length > 0 || mine) && duration > 0 && (
        <div className="relative mx-3 h-6" data-testid="pin-track">
          <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded bg-border" />
          {pins.map((p) => (
            <Marker
              key={p.commentId}
              pin={p}
              label={t('markerAt', { n: String(p.n), time: clockOf(p.pin.atSeconds ?? 0), text: excerpt(p.body) })}
              onClick={() => {
                seek(p.pin.atSeconds ?? 0);
                revealComment(p.commentId);
              }}
              style={{ left: at(p.pin.atSeconds ?? 0), top: '50%' }}
            />
          ))}
          {mine && <Marker pin={null} label={t('draftMarker')} className="pointer-events-none" style={{ left: at(mine.atSeconds), top: '50%' }} />}
        </div>
      )}
      {canPin && (
        <Button type="button" size="sm" variant="outline" disabled={!url.url} onClick={() => onDraft({ fileId: item.fileId, variantId: item.variantId, atSeconds: Math.round((video.current?.currentTime ?? now) * 10) / 10 })}>
          {t('pinVideoHere', { time: clockOf(now) })}
        </Button>
      )}
    </div>
  );
}

// The board: each image and video with its markers and, under it, its pins as a list of buttons.
export function PinBoard({ media, pins, draft, onDraft, canPin }: { media: readonly PinMedia[]; pins: readonly BoardPin[]; draft: DraftPin | null; onDraft: (pin: DraftPin) => void; canPin: boolean }) {
  const t = useTranslations('social.activity');
  const shown = media.filter((m) => isPinnable(m.mime));
  const labels = useMediaLabels(shown);
  if (shown.length === 0) return null;
  return (
    <section className="space-y-3" aria-label={t('pinsTitle')}>
      <div>
        <h4 className="text-sm font-medium text-foreground">{t('pinsTitle')}</h4>
        {canPin && <p className="text-xs text-subtle-foreground">{t('pinsHint')}</p>}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {shown.map((m) => {
          const key = `${m.variantId ?? 'post'}:${m.fileId}`;
          const label = labels.get(key) ?? '';
          // A file the post and a channel both use shows once, as the post's, with every pin on it.
          const mine = pins.filter((p) => p.pin.fileId === m.fileId);
          const Board = m.mime.startsWith('video/') ? VideoBoard : ImageBoard;
          return (
            <li key={key} className="space-y-1">
              <p className="text-xs text-muted-foreground">{label}</p>
              <Board item={m} label={label} pins={mine} draft={draft} onDraft={onDraft} canPin={canPin} />
              {mine.length > 0 && (
                <ol className="flex flex-wrap gap-1" aria-label={t('pinList', { media: label })}>
                  {mine.map((p) => (
                    <li key={p.commentId}>
                      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => revealComment(p.commentId)}>
                        {p.pin.atSeconds !== null ? t('pinnedAt', { n: String(p.n), time: clockOf(p.pin.atSeconds) }) : t('pinned', { n: String(p.n) })} · {excerpt(p.body)}
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// "Ảnh 1", "Video 2", "Ảnh 1 · Facebook": each file in the order the board shows them, counted per kind.
export function useMediaLabels(media: readonly PinMedia[]): Map<string, string> {
  const t = useTranslations('social.activity');
  const out = new Map<string, string>();
  let images = 0;
  let videos = 0;
  for (const m of media) {
    const video = m.mime.startsWith('video/');
    const n = String(video ? ++videos : ++images);
    const name = video ? t('videoN', { n }) : t('imageN', { n });
    out.set(`${m.variantId ?? 'post'}:${m.fileId}`, m.channel ? t('onChannel', { media: name, channel: m.channel }) : name);
  }
  return out;
}

// The files a post's board shows: the post's own, then each channel's own that the post does not have.
export function boardMedia(post: readonly { fileId: string; mime: string; altText: string | null; durationMs?: number | null | undefined }[], channels: readonly { variantId: string; channel: string; ownMedia: boolean; media: readonly { fileId: string; mime: string; altText: string | null; durationMs?: number | null | undefined }[] }[]): PinMedia[] {
  const out: PinMedia[] = post.map((m) => ({ fileId: m.fileId, mime: m.mime, altText: m.altText ?? '', durationMs: m.durationMs ?? null, variantId: null }));
  const seen = new Set(out.map((m) => m.fileId));
  for (const c of channels) {
    if (!c.ownMedia) continue;
    for (const m of c.media) {
      if (seen.has(m.fileId)) continue;
      out.push({ fileId: m.fileId, mime: m.mime, altText: m.altText ?? '', durationMs: m.durationMs ?? null, variantId: c.variantId, channel: c.channel });
    }
  }
  return out.filter((m) => isPinnable(m.mime));
}
