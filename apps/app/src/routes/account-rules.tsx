// Learned account rules in Settings (issue #1399): what the approvals taught (a vendor's item and the account it was
// approved to) and the keyword rules owners and admins added, each with its provenance. Owners and admins remove any
// rule and add keyword rules; every role reads them. The server enforces every rule; the screen only offers what can
// succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { CategorizationRule } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { ErrorText, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { accountLabel, pickableAccounts } from '../lib/accounts.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.accountRules.list.key() });

function AddKeywordRule() {
  const t = useTranslations('accountRules');
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const [keyword, setKeyword] = useState('');
  const [accountCode, setAccountCode] = useState('');
  // A keyword rule is learned for the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const create = useMutation(
    orpc.accountRules.create.mutationOptions({
      onSuccess: () => {
        setKeyword('');
        setAccountCode('');
        refresh();
      },
    }),
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ keyword: keyword.trim(), accountCode, legalEntityId: entity.legalEntityId });
  }
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} aria-label={t('addTitle')}>
      <p className="text-sm font-medium text-muted-foreground">{t('addTitle')}</p>
      <p className="text-xs text-subtle-foreground">{t('addHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-0 flex-1"
          required
          maxLength={500}
          placeholder={t('keywordPlaceholder')}
          aria-label={t('keyword')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <NativeSelect className="w-56" required value={accountCode} onChange={(e) => setAccountCode(e.target.value)} aria-label={t('account')}>
          <NativeSelectOption value="">{t('pickAccount')}</NativeSelectOption>
          {/* Accounts a purchase line may go to (#430), in use. */}
          {pickableAccounts(accounts.data ?? [], null, 'purchase').map((a) => (
            <NativeSelectOption key={a.code} value={a.code}>
              {accountLabel(a)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="submit" variant="outline" disabled={create.isPending || !entity.ready || !keyword.trim() || !accountCode}>
          {t('add')}
        </Button>
      </div>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </form>
  );
}

function RuleRow({ rule, canManage }: { rule: CategorizationRule; canManage: boolean }) {
  const t = useTranslations('accountRules');
  const tc = useTranslations('common');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation(orpc.accountRules.remove.mutationOptions({ onSuccess: refresh }));
  const text = rule.label?.trim() || rule.matchText;
  const name = rule.confirmedBy ?? t('formerMember');
  const date = f.date(rule.confirmedAt);
  const invoice = rule.sourceDocument ? [rule.sourceDocument.series, rule.sourceDocument.number].filter(Boolean).join('/') : null;
  return (
    <li className="py-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-foreground">{text}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-subtle-foreground">
            <Badge variant="secondary">{rule.matchKind === 'description' ? t('kindDescription') : t('kindKeyword')}</Badge>
            <span>{rule.vendor ? rule.vendor.name : t('allVendors')}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{t('toAccount', { code: rule.accountCode })}</span>
          </div>
          <p className="mt-1 text-xs text-subtle-foreground">{invoice ? t('learnedFrom', { name, date, invoice }) : t('addedBy', { name, date })}</p>
        </div>
        {canManage && !confirming && (
          <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => setConfirming(true)} aria-label={t('removeOf', { rule: text })}>
            {t('remove')}
          </Button>
        )}
      </div>
      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
          <span className="text-sm text-foreground">{t('confirmRemove')}</span>
          <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate({ id: rule.id })}>
            {remove.isPending ? <Spinner className="text-current" /> : null}
            {t('confirm')}
          </Button>
          <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => setConfirming(false)}>
            {tc('cancel')}
          </Button>
        </div>
      )}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </li>
  );
}

export function AccountRulesCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('accountRules');
  // The rules of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const rules = useQuery({ ...orpc.accountRules.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {rules.isPending ? (
        <Spinner />
      ) : rules.error ? (
        <ErrorText>{errorMessage(rules.error)}</ErrorText>
      ) : (rules.data ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground">{t('empty')}</p>
      ) : (
        <ul className="mt-3 divide-y">
          {(rules.data ?? []).map((r) => (
            <RuleRow key={r.id} rule={r} canManage={canManage} />
          ))}
        </ul>
      )}
      {canManage && <AddKeywordRule />}
    </Card>
  );
}
