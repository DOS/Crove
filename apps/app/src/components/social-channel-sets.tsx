// Saved sets of channels (#774): owners and admins name a group of channels on the Channels page, and the composer picks
// a set's channels in one click (still editable after). A channel disconnected later drops out of its sets.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';

type Channel = { id: string; provider: string; displayName: string };

export function ChannelSetsCard({ channels, canEdit }: { channels: readonly Channel[]; canEdit: boolean }) {
  const t = useTranslations('social.channelSets');
  const sets = useQuery(orpc.social.channelSets.list.queryOptions({ input: {} }));
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.channelSets.list.key() });
  const save = useMutation({
    mutationFn: () => client.social.channelSets.save({ name: name.trim(), connectionIds: picked }),
    onSuccess: () => {
      setName('');
      setPicked([]);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (setId: string) => client.social.channelSets.remove({ setId }), onSuccess: refresh });
  const names = new Map(channels.map((c) => [c.id, `${providerName(c.provider)} · ${c.displayName}`]));
  const list = sets.data ?? [];
  if (!canEdit && list.length === 0) return null;
  return (
    <Card className="block space-y-3 p-4">
      <p className="text-sm font-medium text-foreground">{t('title')}</p>
      <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      {list.length > 0 && (
        <ul className="space-y-1 text-sm">
          {list.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-medium text-foreground">{s.name}</span>
                <span className="text-xs text-muted-foreground"> · {s.connectionIds.map((id) => names.get(id) ?? '').filter(Boolean).join(', ') || t('empty')}</span>
              </span>
              {canEdit && (
                <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(s.id)}>
                  {t('remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && channels.length > 0 && (
        <form
          className="space-y-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && picked.length > 0) save.mutate();
          }}
        >
          <Label htmlFor="channel-set-name" className="text-xs">
            {t('name')}
          </Label>
          <Input id="channel-set-name" value={name} maxLength={80} placeholder={t('namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          <div className="flex flex-wrap gap-3">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={picked.includes(c.id)} onCheckedChange={(on) => setPicked(on === true ? [...picked, c.id] : picked.filter((id) => id !== c.id))} />
                {names.get(c.id)}
              </label>
            ))}
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={!name.trim() || picked.length === 0 || save.isPending}>
            {t('save')}
          </Button>
          {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        </form>
      )}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </Card>
  );
}

// The composer's one-click pick: each set selects its channels that are live.
export function ChannelSetPicker({ live, onPick }: { live: readonly { id: string }[]; onPick: (ids: string[]) => void }) {
  const t = useTranslations('social.channelSets');
  const sets = useQuery(orpc.social.channelSets.list.queryOptions({ input: {} }));
  const liveIds = new Set(live.map((c) => c.id));
  const usable = (sets.data ?? []).map((s) => ({ ...s, connectionIds: s.connectionIds.filter((id) => liveIds.has(id)) })).filter((s) => s.connectionIds.length > 0);
  if (usable.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t('pick')}</span>
      {usable.map((s) => (
        <Button key={s.id} type="button" variant="outline" size="sm" onClick={() => onPick(s.connectionIds)}>
          {s.name}
        </Button>
      ))}
    </div>
  );
}
