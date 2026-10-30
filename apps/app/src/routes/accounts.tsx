// The org's chart of accounts in Settings (issue #319): the TT133 accounts are shared and read-only; owners and admins
// add sub-accounts under them (a bank account per bank, a cost center), rename them, and stop or resume using them.
// A sub-account is never deleted, so every posted entry keeps its account. The server enforces every rule; the screen
// only offers what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { normalizeAccountCode } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { accountLabel, parentChoices, subAccounts, type ChartAccount } from '../lib/accounts.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.accounts.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.parties.list.key() });
};

function AddSubAccount({ accounts }: { accounts: readonly ChartAccount[] }) {
  const t = useTranslations('accounts');
  const parents = parentChoices(accounts);
  const [parentCode, setParentCode] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const create = useMutation(
    orpc.accounts.create.mutationOptions({
      onSuccess: () => {
        setCode('');
        setName('');
        refresh();
      },
    }),
  );
  const pickParent = (value: string) => {
    setParentCode(value);
    // Start the code with the parent's, the part every sub-account code shares.
    if (value && !code.startsWith(value)) setCode(value);
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ parentCode, code: normalizeAccountCode(code), name: name.trim() });
  }
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} aria-label={t('addTitle')}>
      <p className="text-xs text-subtle-foreground">{t('addHint')}</p>
      <NativeSelect className="w-full" value={parentCode} required onChange={(e) => pickParent(e.target.value)} aria-label={t('parent')}>
        <NativeSelectOption value="">{t('pickParent')}</NativeSelectOption>
        {parents.map((a) => (
          <NativeSelectOption key={a.code} value={a.code}>
            {accountLabel(a)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <div className="flex gap-2">
        <Input className="w-40 font-mono" required maxLength={31} placeholder={t('codePlaceholder')} aria-label={t('code')} value={code} onChange={(e) => setCode(e.target.value)} />
        <Input required maxLength={200} placeholder={t('namePlaceholder')} aria-label={t('name')} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="outline" disabled={create.isPending || !parentCode}>
          {t('add')}
        </Button>
      </div>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </form>
  );
}

function SubAccountRow({ account, canManage }: { account: ChartAccount; canManage: boolean }) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(account.name);
  const update = useMutation(
    orpc.accounts.update.mutationOptions({
      onSuccess: () => {
        setRenaming(false);
        refresh();
      },
    }),
  );
  const label = accountLabel(account);
  return (
    <li className="py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ code: account.code, name: name.trim() });
            }}
          >
            <span className="shrink-0 py-1.5 font-mono text-foreground">{account.code}</span>
            <Input required maxLength={200} aria-label={t('renameOf', { code: account.code })} value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="outline" size="sm" disabled={update.isPending}>
              {t('save')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(false)}>
              {tc('cancel')}
            </Button>
          </form>
        ) : (
          <div className="min-w-0">
            <p className="truncate text-foreground">
              <span className="font-mono">{account.code}</span> · {account.name}
            </p>
            <p className="text-xs text-subtle-foreground">{t('under', { parent: account.parentCode ?? '', root: account.rootCode })}</p>
          </div>
        )}
        {!renaming && (
          <div className="flex shrink-0 items-center gap-2">
            {!account.active && <Badge variant="secondary">{t('inactive')}</Badge>}
            {canManage && (
              <>
                <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => setRenaming(true)} aria-label={t('renameOf', { code: account.code })}>
                  {t('rename')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ code: account.code, active: !account.active })}
                  aria-label={account.active ? t('deactivateOf', { account: label }) : t('reactivateOf', { account: label })}
                >
                  {account.active ? t('deactivate') : t('reactivate')}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {update.error && <ErrorText>{errorMessage(update.error)}</ErrorText>}
    </li>
  );
}

export function ChartOfAccountsCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('accounts');
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const own = subAccounts(accounts.data ?? []);
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {accounts.isLoading ? (
        <RowsSkeleton />
      ) : accounts.error ? (
        <ErrorText>{errorMessage(accounts.error)}</ErrorText>
      ) : (
        <>
          {own.length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('empty')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {own.map((a) => (
                <SubAccountRow key={a.code} account={a} canManage={canManage} />
              ))}
            </ul>
          )}
          {canManage && <AddSubAccount accounts={accounts.data ?? []} />}
        </>
      )}
    </Card>
  );
}
