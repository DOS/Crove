// The org's event types in Settings (issue #1314), with the crm module: the kinds of meeting a client books with a
// member on the booking page (C3). Owners and admins add and change any; a member those they host; a viewer reads.
// Event types are archived, not deleted. The server enforces every rule; the screen offers only what can succeed.
// Team types (#1373): owners and admins pick round-robin or collective and the co-hosts; a member sees them only.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { EVENT_TYPE_ASSIGNMENTS, EVENT_TYPE_LOCATION_KINDS, type EventType, type EventTypeAssignment, type EventTypeLocationKind } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText, RowsSkeleton, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import {
  coHostChoices,
  draftOf,
  hostChoices,
  inputOf,
  mayManage,
  withCoHost,
  withHost,
  withTitle,
  type EventTypeDraft,
  type EventTypeMember,
} from '../lib/event-types.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.crm.eventTypes.list.key() });

const nameOf = (members: readonly EventTypeMember[], userId: string) => {
  const m = members.find((x) => x.userId === userId);
  return m ? (m.displayName ?? m.email) : null;
};

function EventTypeForm({
  type,
  members,
  me,
  manager,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  type: EventType | null;
  members: readonly EventTypeMember[];
  me: string;
  manager: boolean;
  pending: boolean;
  submitLabel: string;
  onSubmit: (input: Exclude<ReturnType<typeof inputOf>, { invalid: unknown }>['input']) => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('eventTypes');
  const tc = useTranslations('common');
  const [draft, setDraft] = useState<EventTypeDraft>(() => draftOf(type, me));
  const [invalid, setInvalid] = useState<keyof EventTypeDraft | null>(null);
  const set = <K extends keyof EventTypeDraft>(key: K, value: EventTypeDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = inputOf(draft);
    if ('invalid' in result) {
      setInvalid(result.invalid);
      return;
    }
    setInvalid(null);
    onSubmit(result.input);
  };
  const number = (key: 'durationMin' | 'bufferBeforeMin' | 'bufferAfterMin' | 'minNoticeHours' | 'horizonDays' | 'dailyLimit', placeholder?: string) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {t(`fields.${key}`)}
      <Input inputMode="decimal" className="w-28" value={draft[key]} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} aria-invalid={invalid === key} />
    </label>
  );
  return (
    <form className="mt-2 space-y-2" onSubmit={submit} aria-label={type ? t('editOf', { title: type.title }) : t('addTitle')}>
      <Input required maxLength={120} placeholder={t('titlePlaceholder')} aria-label={t('fields.title')} value={draft.title} onChange={(e) => setDraft((d) => withTitle(d, e.target.value))} />
      <div className="flex items-center gap-2 text-sm">
        <span className="text-subtle-foreground">/</span>
        <Input
          required
          maxLength={60}
          className="font-mono"
          aria-label={t('fields.slug')}
          value={draft.slug}
          onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value, slugEdited: true }))}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        {number('durationMin')}
        {number('bufferBeforeMin')}
        {number('bufferAfterMin')}
        {number('minNoticeHours')}
        {number('horizonDays')}
        {number('dailyLimit', t('noLimit'))}
      </div>
      <div className="flex flex-wrap gap-2">
        <NativeSelect className="min-w-40" value={draft.locationKind} onChange={(e) => set('locationKind', e.target.value as EventTypeLocationKind)} aria-label={t('fields.locationKind')}>
          {EVENT_TYPE_LOCATION_KINDS.map((k) => (
            <NativeSelectOption key={k} value={k}>
              {t(`locations.${k}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Input className="min-w-48 flex-1" maxLength={500} placeholder={t(`locationPlaceholders.${draft.locationKind}`)} aria-label={t('fields.locationValue')} value={draft.locationValue} onChange={(e) => set('locationValue', e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <NativeSelect className="min-w-48 flex-1" value={draft.hostUserId} disabled={!manager} onChange={(e) => setDraft((d) => withHost(d, e.target.value))} aria-label={t('fields.host')}>
          {hostChoices(members, me, manager).map((m) => (
            <NativeSelectOption key={m.userId} value={m.userId}>
              {m.displayName ?? m.email}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect className="min-w-48" value={draft.assignment} disabled={!manager} onChange={(e) => set('assignment', e.target.value as EventTypeAssignment)} aria-label={t('fields.assignment')}>
          {EVENT_TYPE_ASSIGNMENTS.map((a) => (
            <NativeSelectOption key={a} value={a}>
              {t(`assignments.${a}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {draft.assignment !== 'single' && (
        <fieldset className="space-y-1" aria-invalid={invalid === 'coHostUserIds'}>
          <legend className="text-xs text-muted-foreground">{t('fields.coHostUserIds')}</legend>
          <p className="text-xs text-subtle-foreground">{t(`assignmentHints.${draft.assignment}`)}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {coHostChoices(members, draft.hostUserId).map((m) => (
              <label key={m.userId} className="flex items-center gap-2 text-sm">
                <Checkbox checked={draft.coHostUserIds.includes(m.userId)} disabled={!manager} onCheckedChange={(on) => setDraft((d) => withCoHost(d, m.userId, on === true))} />
                {m.displayName ?? m.email}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Textarea maxLength={1000} rows={2} placeholder={t('descriptionPlaceholder')} aria-label={t('fields.description')} value={draft.description} onChange={(e) => set('description', e.target.value)} />
      {invalid === 'coHostUserIds' ? (
        <ErrorText>{t('coHostsNeeded')}</ErrorText>
      ) : invalid ? (
        <ErrorText>{t('invalidField', { field: t(`fields.${invalid}` as 'fields.title') })}</ErrorText>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={pending || !draft.title.trim() || !draft.slug.trim()}>
          {pending ? <Spinner className="text-current" /> : null}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {tc('cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

function EventTypeRow({ type, members, me, manager, editor }: { type: EventType; members: readonly EventTypeMember[]; me: string; manager: boolean; editor: boolean }) {
  const t = useTranslations('eventTypes');
  const [editing, setEditing] = useState(false);
  const update = useMutation(
    orpc.crm.eventTypes.update.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await refresh();
      },
    }),
  );
  const setActive = useMutation(orpc.crm.eventTypes.setActive.mutationOptions({ onSuccess: refresh }));
  // A viewer changes nothing, even a type they still host.
  const canManage = editor && mayManage(type, me, manager);
  const host = nameOf(members, type.hostUserId);
  const coHosts = type.coHostUserIds.map((id) => nameOf(members, id)).filter((n): n is string => n !== null);
  return (
    <li className="py-2 text-sm">
      {editing ? (
        <EventTypeForm
          type={type}
          members={members}
          me={me}
          manager={manager}
          pending={update.isPending}
          submitLabel={t('save')}
          onSubmit={(input) => update.mutate({ eventTypeId: type.id, ...input })}
          onCancel={() => {
            setEditing(false);
            update.reset();
          }}
        />
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-foreground">
              <span className="truncate">{type.title}</span>
              {!type.active && <Badge variant="secondary">{t('archived')}</Badge>}
            </p>
            <p className="text-xs text-subtle-foreground">
              <span className="font-mono">/{type.slug}</span> · {t('minutes', { count: String(type.durationMin) })} · {t(`locations.${type.locationKind}`)}
              {host ? ` · ${t('hostedBy', { name: host })}` : null}
              {type.assignment !== 'single' ? ` · ${t(`assignments.${type.assignment}`)}${coHosts.length > 0 ? `: ${coHosts.join(', ')}` : ''}` : null}
            </p>
          </div>
          {canManage && (
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={t('editOf', { title: type.title })}>
                {t('edit')}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={setActive.isPending} onClick={() => setActive.mutate({ eventTypeId: type.id, active: !type.active })}>
                {type.active ? t('archive') : t('restore')}
              </Button>
            </div>
          )}
        </div>
      )}
      {(update.error ?? setActive.error) && <ErrorText>{errorMessage(update.error ?? setActive.error)}</ErrorText>}
    </li>
  );
}

function AddEventType({ members, me, manager }: { members: readonly EventTypeMember[]; me: string; manager: boolean }) {
  const t = useTranslations('eventTypes');
  // A new form after each add, so the fields start empty again.
  const [round, setRound] = useState(0);
  const create = useMutation(
    orpc.crm.eventTypes.create.mutationOptions({
      onSuccess: async () => {
        setRound((r) => r + 1);
        await refresh();
      },
    }),
  );
  return (
    <div className="mt-4">
      <p className="text-xs font-medium text-muted-foreground">{t('addTitle')}</p>
      <EventTypeForm key={round} type={null} members={members} me={me} manager={manager} pending={create.isPending} submitLabel={t('add')} onSubmit={(input) => create.mutate(input)} />
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </div>
  );
}

// Every member reads the list; role decides what they may change.
export function EventTypesCard({ members, me, role }: { members: readonly EventTypeMember[]; me: string; role: EventTypeMember['role'] }) {
  const t = useTranslations('eventTypes');
  const types = useQuery(orpc.crm.eventTypes.list.queryOptions());
  const manager = role === 'owner' || role === 'admin';
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {types.isLoading ? (
        <RowsSkeleton />
      ) : types.error ? (
        <ErrorText>{errorMessage(types.error)}</ErrorText>
      ) : (
        <>
          {(types.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('empty')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {(types.data ?? []).map((type) => (
                <EventTypeRow key={`${type.id}:${type.updatedAt}`} type={type} members={members} me={me} manager={manager} editor={role !== 'viewer'} />
              ))}
            </ul>
          )}
          {role !== 'viewer' && <AddEventType members={members} me={me} manager={manager} />}
        </>
      )}
    </Card>
  );
}
