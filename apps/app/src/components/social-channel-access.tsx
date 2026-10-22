// Channels a member may use (#1081), on the Channels page: owners and admins give a member or a viewer every channel
// or a chosen few (a freelancer, the client's editor); owners and admins always use every channel. A limited member
// sees which channels are theirs, and the composer, the lists and the exports offer those only.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';

type Channel = { id: string; provider: string; displayName: string };
type Member = { userId: string; email: string; displayName: string | null; role: string };

export interface ChannelScope {
  // Still reading the caller's limit: offer nothing that may turn out to be someone else's.
  loading: boolean;
  limited: boolean;
  allows: (connectionId: string) => boolean;
}

/** The caller's channels: every one, or the ones an owner or admin gave them. */
export function useChannelScope(): ChannelScope {
  const mine = useQuery({ ...orpc.social.channelAccess.mine.queryOptions({ input: {} }), staleTime: 60_000 });
  const ids = new Set(mine.data?.connectionIds ?? []);
  const limited = mine.data?.limited ?? false;
  return { loading: mine.isLoading, limited, allows: (id) => !mine.isLoading && (!limited || ids.has(id)) };
}

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.social.channelAccess.key() });
  // What a limited member sees of posts and metrics follows the list.
  void queryClient.invalidateQueries({ queryKey: orpc.social.posts.key() });
};

function MemberRow({ member, channels, current }: { member: Member; channels: readonly Channel[]; current: readonly string[] }) {
  const t = useTranslations('social.channelAccess');
  const [mode, setMode] = useState<'all' | 'some'>(current.length > 0 ? 'some' : 'all');
  const [picked, setPicked] = useState<string[]>([...current]);
  const save = useMutation({
    mutationFn: () => client.social.channelAccess.set({ userId: member.userId, channelConnectionIds: mode === 'all' ? [] : picked }),
    onSuccess: refresh,
  });
  const names = new Map(channels.map((c) => [c.id, `${providerName(c.provider)} · ${c.displayName}`]));
  // A channel disconnected since still limits the member, so it stays on the list until it is unticked.
  const gone = current.filter((id) => !names.has(id));
  const wanted = mode === 'all' ? [] : [...picked].sort();
  const changed = wanted.join(',') !== [...current].sort().join(',');
  const name = member.displayName ?? member.email;
  const selectId = `channel-access-${member.userId}`;
  return (
    <li className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          {member.displayName && <p className="truncate text-xs text-subtle-foreground">{member.email}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={selectId} className="sr-only">
            {t('modeLabel', { name })}
          </Label>
          <NativeSelect id={selectId} size="sm" value={mode} onChange={(e) => setMode(e.target.value === 'some' ? 'some' : 'all')}>
            <NativeSelectOption value="all">{t('allChannels')}</NativeSelectOption>
            <NativeSelectOption value="some">{t('someChannels')}</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>
      {mode === 'some' && (
        <fieldset className="space-y-1.5">
          <legend className="sr-only">{t('pickLegend', { name })}</legend>
          <div className="flex flex-wrap gap-3">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={picked.includes(c.id)} onCheckedChange={(on) => setPicked(on === true ? [...picked, c.id] : picked.filter((id) => id !== c.id))} />
                {names.get(c.id)}
              </label>
            ))}
            {gone.map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={picked.includes(id)} onCheckedChange={(on) => setPicked(on === true ? [...picked, id] : picked.filter((x) => x !== id))} />
                {t('goneChannel')}
              </label>
            ))}
          </div>
          {picked.length === 0 && <p className="text-xs text-warning">{t('pickOne')}</p>}
        </fieldset>
      )}
      {changed && (
        <Button variant="outline" size="sm" disabled={save.isPending || (mode === 'some' && picked.length === 0)} onClick={() => save.mutate()}>
          {t('save')}
        </Button>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </li>
  );
}

export function ChannelAccessCard({ channels, canEdit }: { channels: readonly Channel[]; canEdit: boolean }) {
  const t = useTranslations('social.channelAccess');
  const scope = useChannelScope();
  const mine = useQuery({ ...orpc.social.channelAccess.mine.queryOptions({ input: {} }), enabled: !canEdit });
  const org = useQuery({ ...orpc.org.get.queryOptions(), enabled: canEdit });
  const lists = useQuery({ ...orpc.social.channelAccess.list.queryOptions({ input: {} }), enabled: canEdit });
  if (!canEdit) {
    if (!scope.limited) return null;
    const names = new Map(channels.map((c) => [c.id, `${providerName(c.provider)} · ${c.displayName}`]));
    const own = (mine.data?.connectionIds ?? []).map((id) => names.get(id) ?? t('goneChannel'));
    return (
      <Card className="block space-y-1 p-4" role="status">
        <p className="text-sm font-medium text-foreground">{t('limitedTitle')}</p>
        <p className="text-xs text-subtle-foreground">{t('limitedHint', { channels: own.join(', ') })}</p>
      </Card>
    );
  }
  const byUser = new Map((lists.data ?? []).map((l) => [l.userId, l.connectionIds]));
  const members = org.data?.members ?? [];
  const limitable = members.filter((m) => m.role === 'member' || m.role === 'viewer');
  const managers = members.filter((m) => m.role === 'owner' || m.role === 'admin');
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {(org.error || lists.error) && <ErrorText>{errorMessage(org.error ?? lists.error)}</ErrorText>}
      {!org.isLoading && !lists.isLoading && limitable.length === 0 && <p className="text-xs text-subtle-foreground">{t('noMembers')}</p>}
      {lists.data && limitable.length > 0 && (
        <ul className="space-y-3">
          {limitable.map((m) => {
            const current = byUser.get(m.userId) ?? [];
            return <MemberRow key={`${m.userId}:${current.join(',')}`} member={m} channels={channels} current={current} />;
          })}
        </ul>
      )}
      {managers.length > 0 && (
        <p className="text-xs text-subtle-foreground">
          <Badge variant="outline" className="mr-2">
            {t('alwaysAll')}
          </Badge>
          {managers.map((m) => m.displayName ?? m.email).join(', ')}
        </p>
      )}
    </Card>
  );
}
