// Saved views of the Social home (#1300): the member's named filters and the ones shared with the team, applied in one
// click (the address takes the view's filters, so the list, the board or the calendar opens as saved). The view whose
// filters the address shows is the one selected; after a change of filters its owner (or an owner or admin, for a
// shared one) updates it in place, saves the filters as a new view, or deletes it. At most 20 per member (the server
// counts them).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { sameViewFilters, searchOfView, viewFiltersOf, type SocialSearch, type ViewFilters } from '../lib/social.ts';

// The views one member keeps per org, as the server counts them.
const SAVED_VIEW_LIMIT = 20;

type SavedView = Awaited<ReturnType<typeof client.social.savedViews.list>>[number];

// search: the address now; onApply: the address a view opens. canShare: members and above share with the team.
export function SavedViews({
  search,
  members,
  canShare,
  onApply,
}: {
  search: SocialSearch;
  members: readonly { userId: string; name: string }[];
  canShare: boolean;
  onApply: (next: SocialSearch) => void;
}) {
  const t = useTranslations('social.views');
  const limitId = useId();
  const views = useQuery(orpc.social.savedViews.list.queryOptions({ input: {} }));
  const list = views.data ?? [];
  const current = viewFiltersOf(search);
  // The view picked last, while the address may have moved away from it; else the one the address matches.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const matching = list.find((v) => sameViewFilters(v.filters as ViewFilters, current));
  const picked = list.find((v) => v.id === pickedId) ?? matching ?? null;
  const changed = picked !== null && !sameViewFilters(picked.filters as ViewFilters, current);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const nameOf = (userId: string) => members.find((m) => m.userId === userId)?.name ?? t('someone');
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.social.savedViews.key() });
  const save = useMutation({
    mutationFn: (input: { viewId?: string; name: string; shared: boolean }) => client.social.savedViews.save({ ...input, filters: current }),
    onSuccess: ({ viewId }, input) => {
      setPickedId(viewId);
      setNaming(false);
      setName('');
      setNotice(t('saved', { name: input.name }));
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (view: SavedView) => client.social.savedViews.remove({ viewId: view.id }),
    onSuccess: (_, view) => {
      setPickedId(null);
      setNotice(t('removed', { name: view.name }));
      void refresh();
    },
  });
  const apply = (id: string) => {
    setNotice(null);
    const view = list.find((v) => v.id === id);
    setPickedId(view?.id ?? null);
    // The placeholder leaves the view: the home without its filters.
    onApply(view ? searchOfView(view.filters) : {});
  };
  const mine = list.filter((v) => v.mine);
  const others = list.filter((v) => !v.mine);
  // At the limit no new view can be saved (the server refuses it too); an existing one can still be updated.
  const full = mine.length >= SAVED_VIEW_LIMIT;
  const error = save.error ?? remove.error ?? views.error;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        {list.length > 0 && (
          <label className="text-xs">
            <span className="text-subtle-foreground">{t('label')}</span>
            <NativeSelect className="mt-1 w-64" value={picked?.id ?? ''} onChange={(e) => apply(e.target.value)}>
              <NativeSelectOption value="">{t('pick')}</NativeSelectOption>
              {mine.length > 0 && (
                <NativeSelectOptGroup label={t('mine')}>
                  {mine.map((v) => (
                    <NativeSelectOption key={v.id} value={v.id}>
                      {v.shared ? t('sharedName', { name: v.name }) : v.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              )}
              {others.length > 0 && (
                <NativeSelectOptGroup label={t('shared')}>
                  {others.map((v) => (
                    <NativeSelectOption key={v.id} value={v.id}>
                      {t('ownedBy', { name: v.name, owner: nameOf(v.ownerId) })}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              )}
            </NativeSelect>
          </label>
        )}
        {picked && changed && picked.canChange && (
          <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate({ viewId: picked.id, name: picked.name, shared: picked.shared })}>
            {t('update', { name: picked.name })}
          </Button>
        )}
        {!naming && (
          <Button
            variant="ghost"
            disabled={full}
            aria-describedby={full ? limitId : undefined}
            onClick={() => {
              setNotice(null);
              setShared(false);
              setNaming(true);
            }}
          >
            {t('save')}
          </Button>
        )}
        {picked && picked.canChange && (
          <Button variant="ghost" disabled={remove.isPending} onClick={() => window.confirm(t('removeConfirm', { name: picked.name })) && remove.mutate(picked)}>
            {t('remove')}
          </Button>
        )}
      </div>
      {full && (
        <p id={limitId} className="text-xs text-warning">
          {t('limit', { limit: String(SAVED_VIEW_LIMIT) })}
        </p>
      )}
      {naming && (
        <form
          aria-label={t('save')}
          className="flex flex-wrap items-end gap-3 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate({ name: name.trim(), shared: canShare && shared });
          }}
        >
          <label className="min-w-48 flex-1 text-xs sm:max-w-80">
            <span className="text-subtle-foreground">{t('name')}</span>
            <Input className="mt-1" value={name} maxLength={60} required autoFocus placeholder={t('namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </label>
          {canShare && (
            <label className="flex items-center gap-2 pb-2 text-xs text-muted-foreground" title={t('shareHint')}>
              <Checkbox checked={shared} onCheckedChange={(on) => setShared(on === true)} />
              {t('share')}
            </label>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {t('create')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setNaming(false);
                save.reset();
              }}
            >
              {t('cancel')}
            </Button>
          </div>
          {canShare && shared && <p className="w-full text-xs text-subtle-foreground">{t('shareHint')}</p>}
        </form>
      )}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
      <p role="status" className="text-xs text-muted-foreground empty:hidden">
        {notice}
      </p>
    </div>
  );
}
