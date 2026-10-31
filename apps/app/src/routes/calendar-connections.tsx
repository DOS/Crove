// SPDX-License-Identifier: AGPL-3.0-only
// The member's outside calendars in Settings (issue #2123, part of #1374): connect Google Calendar, see when each last
// synced, disconnect. The busy times of a connected calendar block booking slots; only start and end are read. With no
// OAuth app configured on the server no connect button is shown and the card stays out of the way. A viewer has no
// calendar of their own to connect.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { CalendarConnectionView, CalendarOAuthProvider } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { ErrorText, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { rememberOAuthAttempt } from '../lib/oauth.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.calendar.connections.key() });

function ConnectionRow({ connection, canEdit, onAllowWriteBack }: { connection: CalendarConnectionView; canEdit: boolean; onAllowWriteBack: () => void }) {
  const t = useTranslations('workingHours');
  const f = useFormat();
  const disconnect = useMutation(orpc.calendar.disconnect.mutationOptions({ onSuccess: refresh }));
  const writeBack = useMutation(orpc.calendar.setWriteBack.mutationOptions({ onSuccess: refresh }));
  // Writing appointments is Google's for now, for a member who edits, on a connection that works.
  const offerWriteBack = canEdit && connection.provider === 'google' && connection.status === 'active';
  const note =
    connection.status === 'expired'
      ? t('externalExpired')
      : connection.statusReason
        ? t('externalFailed')
        : connection.lastSyncedAt
          ? t('externalSynced', { time: f.dateTime(connection.lastSyncedAt) })
          : t('externalNeverSynced');
  return (
    <li className="py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {t(`externalProviders.${connection.provider}`)}: {connection.displayName}
        </span>
        <span className={connection.status === 'expired' || connection.statusReason ? 'block text-xs text-destructive' : 'block text-xs text-subtle-foreground'}>{note}</span>
      </span>
      <Button type="button" variant="ghost" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate({ connectionId: connection.id })} aria-label={t('externalDisconnectOf', { name: connection.displayName })}>
        {t('externalDisconnect')}
      </Button>
      </div>
      {offerWriteBack &&
        (connection.canWriteBack ? (
          <label className="mt-1 flex items-start gap-2 text-xs text-muted-foreground">
            <Checkbox checked={connection.writeBack} disabled={writeBack.isPending} onCheckedChange={(on) => writeBack.mutate({ connectionId: connection.id, enabled: on === true })} />
            <span>
              <span className="font-medium text-foreground">{t('externalWriteBack')}</span>
              <span className="block">{t('externalWriteBackHint')}</span>
            </span>
          </label>
        ) : (
          <div className="mt-1 text-xs text-muted-foreground">
            <p>{t('externalWriteBackHint')}</p>
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={onAllowWriteBack}>
              {t('externalAllowWriteBack')}
            </Button>
          </div>
        ))}
      {writeBack.error && <ErrorText>{errorMessage(writeBack.error)}</ErrorText>}
    </li>
  );
}

export function ExternalCalendars({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('workingHours');
  const providers = useQuery(orpc.calendar.providers.queryOptions());
  const connections = useQuery(orpc.calendar.connections.queryOptions());
  const start = useMutation({
    mutationFn: (v: { provider: CalendarOAuthProvider; writeBack?: boolean }) => client.calendar.connectStart(v.writeBack ? { provider: v.provider, writeBack: true } : { provider: v.provider }),
    onSuccess: (attempt) => {
      // The org the screen is showing: the provider sends the browser back to one address for every org.
      const slug = getCurrentOrg();
      if (slug) rememberOAuthAttempt(attempt.state, slug);
      window.location.assign(attempt.authorizeUrl);
    },
  });
  const offered: readonly CalendarOAuthProvider[] = providers.data ?? [];
  const rows = connections.data ?? [];
  // Nothing to connect and nothing connected: the feature is not on for this server.
  if (offered.length === 0 && rows.length === 0) return null;
  return (
    <div className="mt-4" aria-label={t('externalTitle')}>
      <p className="text-xs font-medium text-muted-foreground">{t('externalTitle')}</p>
      <p className="mt-1 text-xs text-subtle-foreground">{t('externalIntro')}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-subtle-foreground">{t('externalNone')}</p>
      ) : (
        <ul className="mt-2 divide-y">
          {rows.map((c) => (
            <ConnectionRow key={c.id} connection={c} canEdit={canEdit} onAllowWriteBack={() => start.mutate({ provider: 'google_calendar', writeBack: true })} />
          ))}
        </ul>
      )}
      {canEdit && offered.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {offered.map((p) => (
            <Button key={p} type="button" variant="outline" size="sm" disabled={start.isPending} onClick={() => start.mutate({ provider: p })}>
              {start.isPending && start.variables?.provider === p ? <Spinner className="text-current" /> : null}
              {t('externalConnect', { provider: t(`externalProviders.${p}`) })}
            </Button>
          ))}
        </div>
      )}
      {(start.error ?? connections.error) && <ErrorText>{errorMessage(start.error ?? connections.error)}</ErrorText>}
    </div>
  );
}
