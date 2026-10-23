// Suggested edits (#1236), as Planable's suggestions: a member selects words of the post's text or of a channel's own
// text and suggests others, with an optional note; the suggestion shows in the comments with what changes (old → new),
// and a member who may edit the post takes it (Nhận) or leaves it (Bỏ qua). The server decides everything: it refuses a
// suggestion on text the page did not show as saved, and never applies one whose words are no longer in the text.
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText, Spinner } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { selectedRange, type SelectedRange } from '../lib/social-suggest.ts';

type Item = Awaited<ReturnType<typeof client.social.posts.activity>>['items'][number];
export type Suggestion = NonNullable<Item['suggestion']>;

const MAX = 4000;

/** The selection of a text box, followed as it changes (mouse, keyboard, typing); null when nothing is selected. */
function useSelection(targetId: string): SelectedRange | null {
  const [range, setRange] = useState<SelectedRange | null>(null);
  useEffect(() => {
    const box = document.getElementById(targetId);
    if (!(box instanceof HTMLTextAreaElement)) return;
    const read = () => setRange(selectedRange(box.value, box.selectionStart, box.selectionEnd));
    const events = ['select', 'keyup', 'mouseup', 'input', 'focus'] as const;
    for (const e of events) box.addEventListener(e, read);
    return () => {
      for (const e of events) box.removeEventListener(e, read);
    };
  }, [targetId]);
  return range;
}

/**
 * *Đề xuất sửa* under a text box: for the words selected in it, a small form with what to put instead and a note.
 * saved: the text as the server holds it; a box with unsaved changes takes no suggestion, since the words must be where
 * the server has them. variantId: the channel whose own text this is (field 'channel').
 */
export function SuggestEdit({ postId, targetId, field, variantId, saved, current }: { postId: string; targetId: string; field: 'post' | 'channel'; variantId?: string; saved: string; current: string }) {
  const t = useTranslations('social.suggest');
  const id = useId();
  const selection = useSelection(targetId);
  const [picked, setPicked] = useState<SelectedRange | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const replacement = useRef<HTMLTextAreaElement>(null);
  const dirty = current !== saved;
  const send = useMutation({
    mutationFn: (range: SelectedRange) =>
      client.social.posts.suggest({ postId, ...(variantId ? { variantId } : {}), ...(note.trim() ? { body: note.trim() } : {}), suggestion: { field, start: range.start, end: range.end, quote: range.quote, text } }),
    onSuccess: () => {
      setPicked(null);
      setNote('');
      setSent(true);
      document.getElementById(targetId)?.focus();
      void queryClient.invalidateQueries({ queryKey: orpc.social.posts.activity.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.social.posts.get.key() });
    },
  });
  const close = () => {
    setPicked(null);
    send.reset();
    document.getElementById(targetId)?.focus();
  };
  useEffect(() => {
    if (picked) replacement.current?.focus();
  }, [picked]);
  if (!picked) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={selection === null || dirty}
          aria-describedby={`${id}-hint`}
          onClick={() => {
            if (!selection) return;
            setSent(false);
            setPicked(selection);
            setText(selection.quote);
          }}
        >
          {t('open')}
        </Button>
        <span id={`${id}-hint`} className="text-xs text-subtle-foreground">
          {dirty ? t('saveFirst') : selection === null ? t('selectFirst') : t('selected', { count: [...selection.quote].length })}
        </span>
        <span role="status" className="text-xs text-success">
          {sent ? t('sent') : ''}
        </span>
      </div>
    );
  }
  const unchanged = text === picked.quote;
  return (
    <form
      className="space-y-2 rounded-md border bg-muted/40 p-3"
      aria-labelledby={`${id}-title`}
      data-testid="suggest-form"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!unchanged && !send.isPending) send.mutate(picked);
      }}
    >
      <p id={`${id}-title`} className="text-sm font-medium text-foreground">
        {t('title')}
      </p>
      <p className="text-xs text-muted-foreground">{t('quoted')}</p>
      <blockquote className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words border-l-2 pl-2 text-sm text-foreground">{picked.quote}</blockquote>
      <Textarea ref={replacement} rows={2} maxLength={MAX} value={text} aria-label={t('replacement')} placeholder={t('replacementHint')} onChange={(e) => setText(e.target.value)} />
      <Textarea rows={2} maxLength={MAX} value={note} aria-label={t('note')} placeholder={t('note')} onChange={(e) => setNote(e.target.value)} />
      {unchanged && <p className="text-xs text-subtle-foreground">{t('unchanged')}</p>}
      {send.error && <ErrorText>{errorMessage(send.error)}</ErrorText>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={unchanged || send.isPending}>
          {send.isPending ? <Spinner className="text-current" /> : null}
          {t('send')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={close}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * A suggestion in the comments: the words around it in the text now, the words taken out and those put in, where it
 * stands, and *Nhận* / *Bỏ qua* for a member who may edit the post. locked: the page has unsaved edits, which an
 * accepted change would overtake, so it waits for them.
 */
export function SuggestionView({ commentId, suggestion: s, channel, locked }: { commentId: string; suggestion: Suggestion; channel: string | null; locked: boolean }) {
  const t = useTranslations('social.suggest');
  const [done, setDone] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries();
  const accept = useMutation({
    mutationFn: () => client.social.posts.acceptSuggestion({ commentId, revision: s.revision ?? 0 }),
    onSuccess: (r) => {
      setDone(t(r.resubmitted.length > 0 ? 'acceptedBack' : 'acceptedDone'));
      refresh();
    },
  });
  const skip = useMutation({
    mutationFn: () => client.social.posts.skipSuggestion({ commentId }),
    onSuccess: () => {
      setDone(t('skippedDone'));
      refresh();
    },
  });
  const error = accept.error ?? skip.error;
  const open = s.state === 'open';
  const where = s.field === 'post' ? t('onPost') : t('onChannel', { channel: channel ?? t('aChannel') });
  const badge =
    s.state === 'accepted'
      ? { tone: 'success' as const, label: t('state.accepted') }
      : s.state === 'skipped'
        ? { tone: 'secondary' as const, label: t('state.skipped') }
        : s.state === 'outdated' || s.outdated
          ? { tone: 'warning' as const, label: t('state.outdated') }
          : s.frozen
            ? { tone: 'warning' as const, label: t('state.frozen') }
            : null;
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/40 p-2" data-testid="suggestion" data-state={s.outdated ? 'outdated' : s.state}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{where}</span>
        {badge && <Badge variant={badge.tone}>{badge.label}</Badge>}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">
        {s.before && <span className="text-muted-foreground">…{s.before}</span>}
        <span className="sr-only">{t('srOld')}</span>
        <del className="rounded-sm bg-destructive/10 px-0.5 text-destructive line-through">{s.quote}</del>
        <span aria-hidden="true"> → </span>
        {s.text === '' ? (
          <span className="text-xs text-muted-foreground">{t('removed')}</span>
        ) : (
          <>
            <span className="sr-only">{t('srNew')}</span>
            <ins className="rounded-sm bg-success/10 px-0.5 text-success no-underline">{s.text}</ins>
          </>
        )}
        {s.after && <span className="text-muted-foreground">{s.after}…</span>}
      </p>
      {open && s.outdated && <p className="text-xs text-warning">{t('outdatedHint')}</p>}
      {open && s.decidable && (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={s.outdated || s.frozen || locked || s.revision === null || accept.isPending || skip.isPending}
            title={locked ? t('lockedHint') : undefined}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? <Spinner className="text-current" /> : null}
            {t('accept')}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={accept.isPending || skip.isPending} onClick={() => skip.mutate()}>
            {t('skip')}
          </Button>
          {locked && <span className="text-xs text-subtle-foreground">{t('lockedHint')}</span>}
        </div>
      )}
      <p role="status" className="text-xs text-success">
        {done ?? ''}
      </p>
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </div>
  );
}
