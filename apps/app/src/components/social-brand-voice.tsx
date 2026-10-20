// The saved brand voice for AI drafts (#741): the org's, on top of the Channels page, and a channel's own under each
// channel. Owners and admins edit; everyone sees what the AI is told. A channel without its own uses the org's.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

export type Voice = Awaited<ReturnType<typeof client.social.brandVoices.list>>[number];

// Words typed with commas between them: trimmed, without empties or duplicates, at most 20.
export function wordList(text: string): string[] {
  return [...new Set(text.split(/[,;\n]+/).map((w) => w.trim().replace(/\s+/g, ' ')).filter((w) => w.length > 0 && w.length <= 40))].slice(0, 20);
}

export function VoiceEditor({ connectionId, voice, canEdit, inherited }: { connectionId: string | null; voice: Voice | undefined; canEdit: boolean; inherited?: boolean }) {
  const t = useTranslations('social.voice');
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(voice?.description ?? '');
  const [useWords, setUseWords] = useState((voice?.useWords ?? []).join(', '));
  const [avoidWords, setAvoidWords] = useState((voice?.avoidWords ?? []).join(', '));
  const [emoji, setEmoji] = useState(voice?.emoji ?? true);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.brandVoices.list.key() });
  const save = useMutation({
    mutationFn: () => client.social.brandVoices.save({ connectionId, description: description.trim(), useWords: wordList(useWords), avoidWords: wordList(avoidWords), emoji }),
    onSuccess: () => {
      setOpen(false);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => client.social.brandVoices.remove({ connectionId }), onSuccess: refresh });
  const id = connectionId ?? 'org';
  if (!open) {
    return (
      <div className="space-y-1">
        {voice ? (
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground">{voice.description}</span>
            {voice.useWords.length > 0 && <span className="block text-xs text-subtle-foreground">{t('useShort', { words: voice.useWords.join(', ') })}</span>}
            {voice.avoidWords.length > 0 && <span className="block text-xs text-subtle-foreground">{t('avoidShort', { words: voice.avoidWords.join(', ') })}</span>}
          </p>
        ) : (
          <p className="text-xs text-subtle-foreground">{connectionId === null ? t('noneOrg') : inherited ? t('usesOrg') : t('noneChannel')}</p>
        )}
        {canEdit && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              {voice ? t('edit') : t('add')}
            </Button>
            {voice && (
              <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {t('remove')}
              </Button>
            )}
          </div>
        )}
        {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`voice-${id}`}>{t('description')}</Label>
        <Textarea id={`voice-${id}`} rows={2} maxLength={600} value={description} placeholder={t('descriptionPlaceholder')} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`voice-use-${id}`}>{t('useWords')}</Label>
          <Input id={`voice-use-${id}`} value={useWords} placeholder={t('wordsPlaceholder')} onChange={(e) => setUseWords(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`voice-avoid-${id}`}>{t('avoidWords')}</Label>
          <Input id={`voice-avoid-${id}`} value={avoidWords} placeholder={t('wordsPlaceholder')} onChange={(e) => setAvoidWords(e.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={emoji} onCheckedChange={(checked) => setEmoji(checked === true)} />
        {t('emoji')}
      </label>
      <div className="flex gap-2">
        <Button size="sm" disabled={!description.trim() || save.isPending} onClick={() => save.mutate()}>
          {t('save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}
