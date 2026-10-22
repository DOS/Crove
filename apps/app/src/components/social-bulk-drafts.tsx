// "Create drafts" from the library (#1080): one draft per picked image or video, in the order picked, for the channels
// chosen (a saved channel set picks them in one click), with an optional caption and an optional place in each
// channel's queue. The server checks every file against every channel first: when one does not fit, nothing is saved
// and each file is listed with its problems.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { captionFromFilename, type IssueCode } from '@crove/mod-social/contract';
import { ChannelSetPicker } from './social-channel-sets.tsx';
import type { LibraryItem } from './social-media.tsx';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';
import { draftsRequest, mediaNumber, type CaptionKind } from '../lib/social-bulk-drafts.ts';

type Result = Awaited<ReturnType<typeof client.social.posts.createFromMedia>>;

export function DraftsFromMediaPanel({ slug, files, onClose, onCreated }: { slug: string; files: readonly LibraryItem[]; onClose: () => void; onCreated: () => void }) {
  const t = useTranslations('social.bulkDrafts');
  const ts = useTranslations('social');
  const f = useFormat();
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const snippets = useQuery(orpc.social.snippets.list.queryOptions({ input: {} }));
  const [picked, setPicked] = useState<string[]>([]);
  const [caption, setCaption] = useState<CaptionKind>('none');
  const [snippetId, setSnippetId] = useState<string | null>(null);
  const [queue, setQueue] = useState(false);
  const live = (channels.data ?? []).filter((c) => c.status !== 'revoked');
  const byChannel = new Map(live.map((c) => [c.id, c]));
  const byFile = new Map(files.map((x) => [x.fileId, x]));
  const request = draftsRequest({ fileIds: files.map((x) => x.fileId), connectionIds: picked, caption, snippetId, queue });
  // One key per request: a retry after a lost answer returns the first answer instead of a second set of drafts.
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const create = useMutation({
    mutationFn: (): Promise<Result> => {
      if (!request) throw new Error(t('incomplete'));
      const payload = JSON.stringify(request);
      if (attempt.current?.payload !== payload) attempt.current = { key: crypto.randomUUID(), payload };
      return client.social.posts.createFromMedia({ ...request, idempotencyKey: attempt.current.key });
    },
    onSuccess: (result) => {
      if (result.status !== 'created') return;
      void queryClient.invalidateQueries({ queryKey: orpc.social.posts.key() });
      void queryClient.invalidateQueries({ queryKey: ['social-library'] });
      onCreated();
    },
  });
  const result = create.data;
  const channelName = (id: string) => {
    const c = byChannel.get(id);
    return c ? `${c.displayName} · ${providerName(c.provider)}` : t('channelGone');
  };
  const issueText = (issue: { code: string; field: string; limit: number | null; actual: number | null }) =>
    ts(`issues.${issue.code as IssueCode}`, { limit: issue.limit ?? 0, actual: issue.actual ?? 0, n: mediaNumber(issue.field) });
  const sample = files[0];
  const snippetList = snippets.data ?? [];
  return (
    <Card className="block space-y-4 p-4" role="dialog" aria-label={t('title', { count: files.length })}>
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title', { count: files.length })}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-foreground">{t('channels')}</legend>
        <ChannelSetPicker live={live} onPick={setPicked} />
        {channels.isLoading ? (
          <Spinner />
        ) : live.length === 0 ? (
          <p className="text-xs text-subtle-foreground">{t('noChannels')}</p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {live.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={picked.includes(c.id)} onCheckedChange={() => setPicked(picked.includes(c.id) ? picked.filter((id) => id !== c.id) : [...picked, c.id])} />
                {c.displayName} · {providerName(c.provider)}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bulk-drafts-caption">{t('caption')}</Label>
          <NativeSelect id="bulk-drafts-caption" className="w-full" value={caption} onChange={(e) => setCaption(e.target.value as CaptionKind)}>
            <NativeSelectOption value="none">{t('captionNone')}</NativeSelectOption>
            <NativeSelectOption value="filename">{t('captionFilename')}</NativeSelectOption>
            <NativeSelectOption value="snippet" disabled={snippetList.length === 0}>
              {t('captionSnippet')}
            </NativeSelectOption>
          </NativeSelect>
          {caption === 'filename' && sample && <p className="text-xs [overflow-wrap:anywhere] text-subtle-foreground">{t('captionFilenameSample', { name: sample.filename, caption: captionFromFilename(sample.filename) })}</p>}
        </div>
        {caption === 'snippet' && (
          <div className="space-y-1.5">
            <Label htmlFor="bulk-drafts-snippet">{t('snippet')}</Label>
            <NativeSelect id="bulk-drafts-snippet" className="w-full" value={snippetId ?? ''} onChange={(e) => setSnippetId(e.target.value || null)}>
              <NativeSelectOption value="">{t('snippetPick')}</NativeSelectOption>
              {snippetList.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {s.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>

      <label className="flex items-start gap-2 text-sm text-muted-foreground">
        <Checkbox className="mt-0.5" checked={queue} onCheckedChange={(on) => setQueue(on === true)} />
        <span>
          <span className="block text-foreground">{t('queue')}</span>
          <span className="block text-xs text-subtle-foreground">{t('queueHint')}</span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!request || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <Spinner className="text-current" /> : null}
          {t('create', { count: files.length })}
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      {(channels.error || snippets.error) && <ErrorText>{errorMessage(channels.error ?? snippets.error)}</ErrorText>}

      {result?.status === 'invalid' && (
        <div className="space-y-2" role="status">
          <p className="text-sm font-medium text-destructive">{t('invalid', { count: result.files.length })}</p>
          <ul className="space-y-2">
            {result.files.map((x) => (
              <li key={x.fileId} className="rounded-lg border px-3 py-2 text-sm">
                <p className="truncate text-foreground" title={byFile.get(x.fileId)?.filename}>
                  {byFile.get(x.fileId)?.filename ?? t('fileGone')}
                </p>
                {x.issues.map((issue, i) => (
                  <p key={i} className="text-xs text-warning">
                    {channelName(issue.connectionId)}: {issueText(issue)}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result?.status === 'created' && (
        <div className="space-y-2" role="status">
          <p className="text-sm font-medium text-success">{t('created', { count: result.posts.length })}</p>
          <ul className="space-y-2">
            {result.posts.map((p) => (
              <li key={p.postId} className="rounded-lg border px-3 py-2 text-sm">
                <Link to="/o/$slug/social/$id" params={{ slug, id: p.postId }} className="block truncate text-link hover:underline" title={byFile.get(p.fileId)?.filename}>
                  {byFile.get(p.fileId)?.filename ?? t('openDraft')}
                </Link>
                {p.variants
                  .filter((v) => v.queueSlotAt !== null)
                  .map((v) => (
                    <p key={v.variantId} className="text-xs text-subtle-foreground">
                      {t('slot', { channel: channelName(v.connectionId), at: f.dateTime(v.queueSlotAt as string) })}
                    </p>
                  ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
