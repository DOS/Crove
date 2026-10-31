// SPDX-License-Identifier: AGPL-3.0-only
// The bank feed card in Settings (ADR-0039 point 3, issue #2099), with the finance module and only where the deployment
// offers a bank feed: owners and admins connect a feed, map each account it lists to a bank account (112) of the books,
// remap or unmap it, and see when each was last synced. Members and viewers only read which accounts are mapped.
// Read-only throughout: a feed brings in bank lines that a person reviews as before, nothing is paid or posted here.
// The server enforces every rule; the screen offers only what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { BankFeedAccountView, LegalEntity } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, FieldError, fieldControl, focusFirstInvalid, RowsSkeleton, Spinner, useFieldErrors } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { accountLabel, type ChartAccount } from '../lib/accounts.ts';
import { bankAccountChoices, feedAccountRows, mappedOf, type FeedAccountRow } from '../lib/bank-feeds.ts';
import type { Role } from '../lib/members.ts';

const refreshAccounts = () => queryClient.invalidateQueries({ queryKey: orpc.bankFeeds.accounts.key() });
const refreshConnections = () => queryClient.invalidateQueries({ queryKey: orpc.bankFeeds.connections.key() });

type ConnectionStatus = 'active' | 'expired' | 'revoked' | 'error';
interface Connection {
  id: string;
  displayName: string;
  status: ConnectionStatus;
}

function ConnectForm() {
  const t = useTranslations('bankFeeds');
  const [name, setName] = useState('');
  const nameId = useId();
  const fields = useFieldErrors<'name'>(() => (name.trim() ? null : t('nameNeeded')));
  const connect = useMutation(
    orpc.bankFeeds.connectSandbox.mutationOptions({
      onSuccess: async () => {
        setName('');
        fields.reset();
        await refreshConnections();
      },
    }),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['name'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    connect.mutate({ displayName: name.trim() });
  };
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} aria-label={t('connectTitle')} noValidate>
      <p className="text-xs font-medium text-muted-foreground">{t('connectTitle')}</p>
      <p className="text-xs text-subtle-foreground">{t('testNote')}</p>
      <div className="flex flex-wrap gap-2">
        <Input
          {...fieldControl(nameId, { error: Boolean(fields.of('name')) })}
          className="min-w-48 flex-1"
          maxLength={200}
          placeholder={t('namePlaceholder')}
          aria-label={t('nameLabel')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            fields.edit('name');
          }}
          onBlur={(e) => fields.blur('name', e.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={connect.isPending}>
          {connect.isPending ? <Spinner className="text-current" /> : null}
          {t('connect')}
        </Button>
      </div>
      <FieldError id={nameId}>{fields.of('name')}</FieldError>
      {connect.error && <ErrorText>{errorMessage(connect.error)}</ErrorText>}
    </form>
  );
}

function LastSynced({ account }: { account: BankFeedAccountView }) {
  const t = useTranslations('bankFeeds');
  const f = useFormat();
  return <>{account.lastSyncedAt ? t('syncedAt', { when: f.dateTime(account.lastSyncedAt) }) : t('neverSynced')}</>;
}

// One account the connection lists (or a mapped one it no longer lists): where its lines go, and the form to choose
// that. The legal entity is chosen only by an org with more than one, and stays with a mapping once made: another one
// takes an unmap first (the server refuses otherwise).
function AccountRow({
  connection,
  row,
  bankAccounts,
  entities,
}: {
  connection: Connection;
  row: FeedAccountRow;
  bankAccounts: readonly ChartAccount[];
  entities: readonly LegalEntity[];
}) {
  const t = useTranslations('bankFeeds');
  const mapped = row.mapped;
  const defaultEntity = entities.find((e) => e.isDefault) ?? entities[0];
  const [bankAccount, setBankAccount] = useState(mapped?.bankAccount ?? '');
  const [legalEntityId, setLegalEntityId] = useState(mapped?.legalEntityId ?? defaultEntity?.id ?? '');
  const bankId = useId();
  const fields = useFieldErrors<'bankAccount'>(() => (bankAccount ? null : t('bankAccountNeeded')));
  const several = entities.length > 1;
  const choices = bankAccountChoices(bankAccounts, mapped?.bankAccount);
  const map = useMutation(orpc.bankFeeds.map.mutationOptions({ onSuccess: () => refreshAccounts() }));
  const unmap = useMutation(
    orpc.bankFeeds.unmap.mutationOptions({
      onSuccess: async () => {
        setBankAccount('');
        await refreshAccounts();
      },
    }),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['bankAccount'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    map.mutate({
      connectionId: connection.id,
      externalAccountId: row.externalAccountId,
      bankAccount,
      ...(several && legalEntityId ? { legalEntityId } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
  };
  const active = connection.status === 'active';
  return (
    <li className="py-3 text-sm">
      <p className="flex flex-wrap items-center gap-2 text-foreground">
        <span className="truncate">{row.displayName}</span>
        {row.displayName !== row.externalAccountId && <span className="font-mono text-xs text-subtle-foreground">{row.externalAccountId}</span>}
      </p>
      {mapped && (
        <p className="text-xs text-subtle-foreground">
          {t('mappedTo', { account: mapped.bankAccount })} · <LastSynced account={mapped} />
        </p>
      )}
      {row.gone && (
        <p className="text-xs text-warning" role="status">
          {t('gone')}
        </p>
      )}
      {!row.gone && (
        <form className="mt-2 space-y-2" onSubmit={submit} aria-label={t('mapForm', { name: row.displayName })} noValidate>
          <div className="flex flex-wrap gap-2">
            <NativeSelect
              {...fieldControl(bankId, { error: Boolean(fields.of('bankAccount')) })}
              className="min-w-48 flex-1"
              aria-label={t('bankAccount')}
              value={bankAccount}
              disabled={!active}
              onChange={(e) => {
                setBankAccount(e.target.value);
                fields.edit('bankAccount');
              }}
            >
              <NativeSelectOption value="">{t('chooseBankAccount')}</NativeSelectOption>
              {choices.map((a) => (
                <NativeSelectOption key={a.code} value={a.code}>
                  {accountLabel(a)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {several && (
              <NativeSelect className="min-w-40" aria-label={t('legalEntity')} value={legalEntityId} disabled={!active || Boolean(mapped)} title={mapped ? t('entityLocked') : undefined} onChange={(e) => setLegalEntityId(e.target.value)}>
                {entities.map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>
                    {e.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <Button type="submit" variant="outline" size="sm" disabled={!active || map.isPending}>
              {map.isPending ? <Spinner className="text-current" /> : null}
              {mapped ? t('remap') : t('map')}
            </Button>
          </div>
          <FieldError id={bankId}>{fields.of('bankAccount')}</FieldError>
          {choices.length === 0 && <p className="text-xs text-subtle-foreground">{t('noBankAccounts')}</p>}
        </form>
      )}
      {mapped && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1"
          disabled={unmap.isPending}
          onClick={() => unmap.mutate({ feedAccountId: mapped.id, idempotencyKey: crypto.randomUUID() })}
          aria-label={t('unmapOf', { name: row.displayName })}
        >
          {unmap.isPending ? <Spinner className="text-current" /> : null}
          {t('unmap')}
        </Button>
      )}
      {(map.error || unmap.error) && <ErrorText>{errorMessage(map.error ?? unmap.error)}</ErrorText>}
    </li>
  );
}

function ConnectionItem({
  connection,
  mapped,
  bankAccounts,
  entities,
}: {
  connection: Connection;
  mapped: readonly BankFeedAccountView[];
  bankAccounts: readonly ChartAccount[];
  entities: readonly LegalEntity[];
}) {
  const t = useTranslations('bankFeeds');
  // The accounts the worker listed: none right after connecting, until the first sync, so ask again while it is empty.
  const listed = useQuery({
    ...orpc.bankFeeds.listed.queryOptions({ input: { connectionId: connection.id } }),
    // Every 5 seconds for two minutes: a listing that stays empty is the provider's answer, not a sync still to come.
    refetchInterval: (query) => (connection.status === 'active' && query.state.data?.length === 0 && query.state.dataUpdateCount < 24 ? 5000 : false),
  });
  const rows = feedAccountRows(listed.data ?? null, mapped);
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="truncate font-medium text-foreground">{connection.displayName}</span>
        <Badge variant={connection.status === 'active' ? 'brand' : 'secondary'}>{t(`status.${connection.status}`)}</Badge>
      </div>
      {connection.status === 'expired' && (
        <p className="mt-1 text-xs text-warning" role="status">
          {t('expiredHint')}
        </p>
      )}
      {connection.status === 'error' && (
        <p className="mt-1 text-xs text-warning" role="status">
          {t('errorHint')}
        </p>
      )}
      {listed.error && <ErrorText>{errorMessage(listed.error)}</ErrorText>}
      {listed.isLoading ? (
        <RowsSkeleton />
      ) : rows.length === 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-xs text-subtle-foreground">{t('waiting')}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void listed.refetch()}>
            {t('refresh')}
          </Button>
        </div>
      ) : (
        <ul className="mt-1 divide-y">
          {rows.map((row) => (
            // Keyed by the mapping too, so the form starts from a mapping made or removed since.
            <AccountRow key={`${row.externalAccountId}:${row.mapped?.id ?? ''}:${row.mapped?.bankAccount ?? ''}`} connection={connection} row={row} bankAccounts={bankAccounts} entities={entities} />
          ))}
        </ul>
      )}
    </li>
  );
}

// What a member or viewer sees: which accounts bring in transactions, and when each was last synced.
function ReadOnlyList({ accounts }: { accounts: readonly BankFeedAccountView[] }) {
  const t = useTranslations('bankFeeds');
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('readOnlyIntro')}</p>
      <ul className="mt-3 divide-y">
        {accounts.map((a) => (
          <li key={a.id} className="py-2 text-sm">
            <p className="text-foreground">
              {a.connectionName}
            </p>
            <p className="text-xs text-subtle-foreground">
              {t('mappedTo', { account: a.bankAccount })} · <LastSynced account={a} />
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// The caller draws it only when the deployment offers a bank feed (lib/bank-feeds.ts bankFeedOffered).
export function BankFeedsCard({ role }: { role: Role }) {
  const t = useTranslations('bankFeeds');
  const canManage = role === 'owner' || role === 'admin';
  const accounts = useQuery(orpc.bankFeeds.accounts.queryOptions());
  const connections = useQuery({ ...orpc.bankFeeds.connections.queryOptions(), enabled: canManage });
  const chart = useQuery({ ...orpc.accounts.list.queryOptions(), enabled: canManage });
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: canManage });
  if (!canManage) {
    // Nothing to change and nothing mapped: nothing to show.
    return accounts.data && accounts.data.length > 0 ? <ReadOnlyList accounts={accounts.data} /> : null;
  }
  // The rows start their forms from the chart and the entities, so wait for both.
  const loading = connections.isLoading || accounts.isLoading || chart.isLoading || entities.isLoading;
  const failure = connections.error ?? accounts.error ?? chart.error ?? entities.error;
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {loading ? (
        <RowsSkeleton />
      ) : failure ? (
        <ErrorText>{errorMessage(failure)}</ErrorText>
      ) : (
        <>
          {(connections.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('noConnections')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {(connections.data ?? []).map((c) => (
                <ConnectionItem key={c.id} connection={c} mapped={mappedOf(accounts.data ?? [], c.id)} bankAccounts={chart.data ?? []} entities={entities.data ?? []} />
              ))}
            </ul>
          )}
          <ConnectForm />
        </>
      )}
    </Card>
  );
}
