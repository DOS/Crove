// A long text split into a thread (#1222), in the channel editor of X, Threads and Bluesky: when the text the channel
// sends is over its limit, *Tách thành chuỗi bài* puts the first post in the channel's own text and the rest in its
// thread parts (#742), as an unsaved edit saved like any other, after a preview of each post with its count. The split
// is the module's splitThread, with the channel's own count and room for the signature and link of the first post.
// *Gộp lại* reverses it: back to the text as it was when nothing was changed since, else the parts joined again.
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { cn } from '@crove/ui/lib/utils';
import { THREAD_PARTS_MAX, THREAD_SPLIT_PROVIDERS, firstCommentOf, isProvider, joinThread, splitThread, threadPartsOf, type ThreadSplit } from '@crove/mod-social/contract';

// The part of a channel's edit the split changes.
export interface SplitValue {
  custom: boolean;
  body: string;
  settings: Record<string, unknown>;
}
export interface SplitSnapshot {
  before: SplitValue;
  after: SplitValue;
}

const same = (a: SplitValue, b: SplitValue) => JSON.stringify([a.custom, a.body, a.settings]) === JSON.stringify([b.custom, b.body, b.settings]);

/** The edit a split makes: the first post as the channel's own text, the others as its thread parts; text left over goes at the end of the last, so nothing is lost and validation flags it. */
export function applySplit(value: SplitValue, split: ThreadSplit): SplitValue {
  const posts = [...split.posts];
  if (split.leftover !== '' && posts.length > 0) posts[posts.length - 1] = `${posts[posts.length - 1]}\n\n${split.leftover}`;
  const [body = '', ...parts] = posts;
  const { threadParts: _old, ...rest } = value.settings;
  return { custom: true, body, settings: parts.length > 0 ? { ...rest, threadParts: parts } : rest };
}

/** The edit back as one text: what it was before the split when nothing changed since, else its posts joined. */
export function joinSplit(value: SplitValue, baseBody: string, snapshot: SplitSnapshot | null): SplitValue {
  if (snapshot && same(value, snapshot.after)) return snapshot.before;
  const { threadParts: _old, ...rest } = value.settings;
  return { custom: true, body: joinThread([value.custom ? value.body : baseBody, ...(threadPartsOf(value.settings) ?? [])]), settings: rest };
}

export function ThreadSplitField({
  provider,
  value,
  baseBody,
  settings,
  linkUrl,
  mediaCount,
  tooLong,
  disabled,
  onChange,
}: {
  provider: string;
  value: SplitValue;
  // The post's shared text, which the channel sends while it has no text of its own.
  baseBody: string;
  // The settings the channel sends with (its signature included while it is being added).
  settings: Record<string, unknown>;
  // The post's link as written; the split adds the channel's tags.
  linkUrl: string | null;
  mediaCount: number;
  // The text the channel sends is over its limit.
  tooLong: boolean;
  disabled: boolean;
  onChange: (value: SplitValue) => void;
}) {
  const t = useTranslations('social.threadSplit');
  const [numbered, setNumbered] = useState(false);
  const [snapshot, setSnapshot] = useState<SplitSnapshot | null>(null);
  const source = value.custom ? value.body : baseBody;
  // Cut only while the text is too long and nothing is split yet; the count of every cut point is not cheap.
  const split = useMemo(
    () => (tooLong && threadPartsOf(value.settings) === null && isProvider(provider) && THREAD_SPLIT_PROVIDERS.has(provider) ? splitThread(provider, source, { settings, linkUrl, mediaCount, numbered }) : null),
    [tooLong, value.settings, provider, source, settings, linkUrl, mediaCount, numbered],
  );
  if (disabled || !isProvider(provider) || !THREAD_SPLIT_PROVIDERS.has(provider)) return null;
  const hasParts = threadPartsOf(value.settings) !== null;
  if (hasParts) {
    const parts = (threadPartsOf(value.settings) ?? []).length + 1;
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {snapshot && same(value, snapshot.after) && <span>{t('done', { count: parts })}</span>}
        <Button variant="outline" size="sm" title={t('joinHint')} onClick={() => onChange(joinSplit(value, baseBody, snapshot))}>
          {t('join')}
        </Button>
      </div>
    );
  }
  if (!tooLong) return null;
  if (!split || split.posts.length < 2) return null;
  const maxPosts = 1 + THREAD_PARTS_MAX;
  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <p className="text-xs text-muted-foreground">{t('hint', { count: split.posts.length })}</p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={numbered} onCheckedChange={(checked) => setNumbered(checked === true)} />
        {t('numbered')}
      </label>
      <details open className="space-y-1">
        <summary className="cursor-pointer text-xs font-medium text-foreground">{t('preview')}</summary>
        <ol className="space-y-1.5 pt-1">
          {split.sent.map((text, i) => {
            const max = (i === 0 ? split.limits.first : split.limits.part) ?? 0;
            const used = split.counts[i] ?? 0;
            return (
              <li key={i} className="rounded border bg-muted/40 p-2">
                <div className={cn('font-mono text-[11px] tabular-nums', used > max ? 'text-destructive' : 'text-subtle-foreground')}>{t('part', { n: i + 1, used, max })}</div>
                <p className="whitespace-pre-wrap break-words text-xs text-foreground">{text}</p>
              </li>
            );
          })}
        </ol>
      </details>
      {split.leftover !== '' && <p className="text-xs text-destructive">{t('leftover', { max: maxPosts, count: split.leftoverCount })}</p>}
      {firstCommentOf(value.settings) !== null && <p className="text-xs text-warning">{t('comment')}</p>}
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          const after = applySplit(value, split);
          setSnapshot({ before: value, after });
          onChange(after);
        }}
      >
        {t('apply')}
      </Button>
    </div>
  );
}
