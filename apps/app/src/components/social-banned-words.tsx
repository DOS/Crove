// Banned and sensitive words (#1055): the org's list on the Channels page, where owners and admins add a word or phrase
// as a warning or a block, for every channel or some; the composer's marks under a text that holds one; and the words
// a channel in review holds. The list starts empty: Crove ships no words of its own.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { findBannedInTexts, variantTexts, type BannedWord } from '@crove/mod-social/contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';
import { bannedSnippet, type BannedHit } from '../lib/social-banned-words.ts';

type Channel = { id: string; provider: string; displayName: string };
type Level = 'warn' | 'block';

const PHRASE_MAX = 100;
const REASON_MAX = 200;

/** The org's words, for the composer and the settings list. */
export function useBannedWords(): readonly BannedWord[] {
  const words = useQuery({ ...orpc.social.bannedWords.list.queryOptions({ input: {} }), staleTime: 60_000 });
  return words.data ?? [];
}

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.social.bannedWords.list.key() });
  // The post view lists the words its channels hold.
  void queryClient.invalidateQueries({ queryKey: orpc.social.posts.key() });
};

export function BannedWordsCard({ channels, canEdit }: { channels: readonly Channel[]; canEdit: boolean }) {
  const t = useTranslations('social.bannedWords');
  const list = useQuery(orpc.social.bannedWords.list.queryOptions({ input: {} }));
  const [phrase, setPhrase] = useState('');
  const [level, setLevel] = useState<Level>('block');
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const add = useMutation({
    mutationFn: () => client.social.bannedWords.add({ phrase: phrase.trim(), level, reason: reason.trim() || null, connectionIds: picked }),
    onSuccess: () => {
      setPhrase('');
      setReason('');
      setPicked([]);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (wordId: string) => client.social.bannedWords.remove({ wordId }), onSuccess: refresh });
  const names = new Map(channels.map((c) => [c.id, `${providerName(c.provider)} · ${c.displayName}`]));
  const words = list.data ?? [];
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {!list.isLoading && words.length === 0 && <p className="text-xs text-subtle-foreground">{t('empty')}</p>}
      {words.length > 0 && (
        <ul className="space-y-1.5 text-sm">
          {words.map((w) => (
            <li key={w.id} className="flex flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <Badge variant={w.level === 'block' ? 'destructive' : 'warning'} className="mr-2">
                  {t(w.level)}
                </Badge>
                <span className="font-medium text-foreground">{w.phrase}</span>
                {w.reason && <span className="text-xs text-muted-foreground"> · {w.reason}</span>}
                <span className="block text-xs text-subtle-foreground">
                  {w.connectionIds.length === 0
                    ? t('allChannels')
                    : t('someChannels', { channels: w.connectionIds.map((id) => names.get(id) ?? t('goneChannel')).join(', ') })}
                </span>
              </span>
              {canEdit && (
                <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(w.id)}>
                  {t('remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      {!canEdit ? (
        <p className="text-xs text-subtle-foreground">{t('adminsOnly')}</p>
      ) : (
        <form
          className="space-y-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (phrase.trim()) add.mutate();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="banned-word-phrase" className="text-xs">
                {t('phrase')}
              </Label>
              <Input id="banned-word-phrase" value={phrase} maxLength={PHRASE_MAX} placeholder={t('phrasePlaceholder')} onChange={(e) => setPhrase(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="banned-word-level" className="text-xs">
                {t('level')}
              </Label>
              <NativeSelect id="banned-word-level" size="sm" className="w-full" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                <NativeSelectOption value="block">{t('blockOption')}</NativeSelectOption>
                <NativeSelectOption value="warn">{t('warnOption')}</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="banned-word-reason" className="text-xs">
              {t('reason')}
            </Label>
            <Input id="banned-word-reason" value={reason} maxLength={REASON_MAX} placeholder={t('reasonPlaceholder')} onChange={(e) => setReason(e.target.value)} />
          </div>
          {channels.length > 0 && (
            <fieldset className="space-y-1.5">
              <legend className="text-xs text-muted-foreground">{t('channels')}</legend>
              <div className="flex flex-wrap gap-3">
                {channels.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Checkbox
                      checked={picked.includes(c.id)}
                      disabled={!picked.includes(c.id) && picked.length >= 50}
                      onCheckedChange={(on) => setPicked(on === true ? [...picked, c.id] : picked.filter((id) => id !== c.id))}
                    />
                    {names.get(c.id)}
                  </label>
                ))}
              </div>
              <p className="text-xs text-subtle-foreground">{t('channelsHint')}</p>
            </fieldset>
          )}
          <Button type="submit" variant="outline" size="sm" disabled={!phrase.trim() || add.isPending}>
            {t('add')}
          </Button>
          {add.error && <ErrorText>{errorMessage(add.error)}</ErrorText>}
        </form>
      )}
    </Card>
  );
}

function HitList({ hits }: { hits: readonly BannedHit[] }) {
  const t = useTranslations('social.bannedWords');
  if (hits.length === 0) return null;
  const blocked = hits.some((h) => h.level === 'block');
  return (
    <div role="status" className="space-y-1 text-xs">
      <p className={blocked ? 'text-destructive' : 'text-warning'}>{blocked ? t('composerBlocked') : t('composerWarned')}</p>
      <ul className="space-y-1">
        {hits.map((h) => (
          <li key={`${h.wordId}:${h.field}:${h.start}`} className="[overflow-wrap:anywhere] text-muted-foreground">
            <Badge variant={h.level === 'block' ? 'destructive' : 'warning'} className="mr-1.5">
              {t(h.level)}
            </Badge>
            {h.before}
            <span className={h.level === 'block' ? 'font-medium text-foreground underline decoration-destructive decoration-wavy underline-offset-2' : 'font-medium text-foreground underline decoration-warning decoration-wavy underline-offset-2'}>
              {h.match}
            </span>
            {h.after}
            {h.field !== 'body' && <span className="text-subtle-foreground"> ({t(`field.${fieldKey(h.field)}`)})</span>}
            {h.reason && <span className="block text-subtle-foreground">{t('reasonShown', { reason: h.reason })}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const fieldKey = (field: string): 'title' | 'firstComment' | 'threadPart' | 'autoReply' | 'poll' | 'body' =>
  field === 'title'
    ? 'title'
    : field === 'settings.firstComment'
      ? 'firstComment'
      : field.startsWith('settings.threadParts.')
        ? 'threadPart'
        : field === 'settings.autoReply.text'
          ? 'autoReply'
          : field.startsWith('settings.poll.')
            ? 'poll'
            : 'body';

/** The composer's marks: each word the texts hold, underlined in a short excerpt, with the owner's reason. */
export function BannedWordHints({ texts, words }: { texts: ReadonlyArray<{ field: string; text: string }>; words: readonly BannedWord[] }) {
  if (words.length === 0) return null;
  const byField = new Map(texts.map((x) => [x.field, x.text]));
  const seen = new Set<string>();
  const hits: BannedHit[] = [];
  for (const m of findBannedInTexts(texts, words)) {
    const key = `${m.wordId}:${m.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(bannedSnippet(byField.get(m.field) ?? '', m));
  }
  return <HitList hits={hits} />;
}

/** The words a channel in review holds, as the server found them in its content. */
export function BannedWordReview({
  channel,
  matches,
  content,
  settings,
}: {
  channel: string;
  matches: ReadonlyArray<Parameters<typeof bannedSnippet>[1]>;
  content: { body: string; title: string | null };
  settings: Readonly<Record<string, unknown>>;
}) {
  const t = useTranslations('social.bannedWords');
  if (matches.length === 0) return null;
  const texts = new Map(variantTexts(content, settings).map((x) => [x.field, x.text]));
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{t('reviewChannel', { channel })}</p>
      <HitList hits={matches.map((m) => bannedSnippet(texts.get(m.field) ?? '', m))} />
    </div>
  );
}
