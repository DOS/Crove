// The org's MISA item and warehouse codes in Settings (issue #1398): purchase lines on a stock account (152, 153, 156
// or a sub-account of one) go to MISA SME's goods purchase template, which needs a MISA catalog item code and a
// warehouse code. Every stock account of the org's chart is listed with the codes the export would write: its own,
// its nearest parent's, or the defaults. Owners and admins set or clear an account's codes; the server enforces every
// rule and the screen shows its reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { accountParents, isStockAccount, resolveMisaGoodsCodes, type AccountParents, type MisaGoodsCode } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { accountLabel, type ChartAccount } from '../lib/accounts.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.misaGoodsCodes.list.key() });

function CodesForm({ account, initial, onDone }: { account: ChartAccount; initial: { itemCode: string; warehouseCode: string | null }; onDone: () => void }) {
  const t = useTranslations('misaGoods');
  const tc = useTranslations('common');
  const [itemCode, setItemCode] = useState(initial.itemCode);
  const [warehouseCode, setWarehouseCode] = useState(initial.warehouseCode ?? '');
  const save = useMutation(
    orpc.misaGoodsCodes.set.mutationOptions({
      onSuccess: () => {
        refresh();
        onDone();
      },
    }),
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    const warehouse = warehouseCode.trim();
    save.mutate({ accountCode: account.code, itemCode: itemCode.trim(), warehouseCode: warehouse === '' ? null : warehouse });
  }
  return (
    <form className="mt-2 space-y-2" onSubmit={submit} aria-label={t('editOf', { code: account.code })}>
      <div className="flex flex-wrap gap-2">
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('itemCode')}</span>
          <Input className="mt-1 w-40 font-mono" required maxLength={25} value={itemCode} onChange={(e) => setItemCode(e.target.value)} />
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('warehouseCode')}</span>
          <Input className="mt-1 w-40 font-mono" maxLength={25} placeholder={t('warehouseNone')} value={warehouseCode} onChange={(e) => setWarehouseCode(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-subtle-foreground">{t('codeHint')}</p>
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={save.isPending}>
          {t('save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {tc('cancel')}
        </Button>
      </div>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </form>
  );
}

function StockAccountRow({ account, saved, parents, canManage }: { account: ChartAccount; saved: readonly MisaGoodsCode[]; parents: AccountParents; canManage: boolean }) {
  const t = useTranslations('misaGoods');
  const [editing, setEditing] = useState(false);
  const remove = useMutation(orpc.misaGoodsCodes.remove.mutationOptions({ onSuccess: refresh }));
  // The badge names the account the codes come from: along the chart's parent chain, as the export resolves them.
  const codes = resolveMisaGoodsCodes(account.code, saved, parents);
  if (!codes) return null;
  const own = codes.from === account.code;
  return (
    <li className="py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-foreground">{accountLabel(account)}</p>
          <p className="text-xs text-subtle-foreground">
            {t('codes', { item: codes.itemCode, warehouse: codes.warehouseCode ?? t('warehouseNone') })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {codes.from === null ? (
            <Badge variant="secondary">{t('default')}</Badge>
          ) : (
            !own && <Badge variant="secondary">{t('inherited', { code: codes.from })}</Badge>
          )}
          {!account.active && <Badge variant="secondary">{t('inactive')}</Badge>}
          {canManage && !editing && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={t('editOf', { code: account.code })}>
                {t('edit')}
              </Button>
              {own && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ accountCode: account.code })}
                  aria-label={t('resetOf', { code: account.code })}
                >
                  {t('reset')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {editing && <CodesForm account={account} initial={codes} onDone={() => setEditing(false)} />}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </li>
  );
}

export function MisaGoodsCodesCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('misaGoods');
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const saved = useQuery(orpc.misaGoodsCodes.list.queryOptions());
  const savedRows = saved.data ?? [];
  // Stock accounts in use, plus an inactive one that still has codes of its own (so they can be cleared).
  const stock = (accounts.data ?? []).filter((a) => isStockAccount(a.code) && (a.active || savedRows.some((s) => s.accountCode === a.code)));
  const parents = accountParents(accounts.data ?? []);
  const error = accounts.error ?? saved.error;
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {accounts.isLoading || saved.isLoading ? (
        <RowsSkeleton />
      ) : error ? (
        <ErrorText>{errorMessage(error)}</ErrorText>
      ) : (
        <ul className="mt-3 divide-y">
          {stock.map((a) => (
            <StockAccountRow key={a.code} account={a} saved={savedRows} parents={parents} canManage={canManage} />
          ))}
        </ul>
      )}
    </Card>
  );
}
