import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { FixedAsset } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DateInput } from '../components/date-input.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { defaultAccounts, fixedAssetFormProblem, fixedAssetInput, monthLabel, previousMonth, recentMonths, type FixedAssetForm, type FixedAssetKind } from '../lib/fixed-assets.ts';
import { localToday } from '../lib/reversal.ts';
import { canEnterVoucher } from '../lib/vouchers.ts';

// The register of fixed assets and prepaid costs (#919): every entry with what it posted and what is left. Owners,
// admins and members add an entry and stop one early, and ask for a month's depreciation, which the kernel builds
// from the register as a general journal voucher that an owner or admin approves in the Inbox (R3, four-eyes, fresh
// MFA).

function AssetFormCard({ onClose }: { onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('fixedAssets');
  const [form, setForm] = useState<FixedAssetForm>(() => ({
    kind: 'fixed_asset',
    name: '',
    cost: '',
    ...defaultAccounts('fixed_asset'),
    startMonth: localToday().slice(0, 7),
    months: '36',
  }));
  const [touched, setTouched] = useState(false);
  // One key per form: a retry of the same entry returns the first result.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const create = useMutation(orpc.fixedAssets.create.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));
  const problem = fixedAssetFormProblem(form);
  const set = (patch: Partial<FixedAssetForm>) => setForm((f) => ({ ...f, ...patch }));

  if (create.data) {
    return (
      <Alert className="mb-6">
        <AlertDescription>
          {t('created')}{' '}
          <Button variant="link" className="h-auto p-0" onClick={onClose}>
            {root('common.close')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card className="mb-6 block p-4">
      <form
        className="space-y-4"
        aria-label={t('newTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (problem) return;
          create.mutate({ ...fixedAssetInput(form), idempotencyKey });
        }}
      >
        <div>
          <h2 className="text-sm font-semibold">{t('newTitle')}</h2>
          <p className="mt-1 text-xs text-subtle-foreground">{t('newIntro')}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('kind')}</span>
            <NativeSelect
              className="mt-1 w-full"
              value={form.kind}
              onChange={(e) => {
                const kind = e.target.value as FixedAssetKind;
                set({ kind, ...defaultAccounts(kind) });
              }}
            >
              <NativeSelectOption value="fixed_asset">{t('kinds.fixed_asset')}</NativeSelectOption>
              <NativeSelectOption value="prepaid_cost">{t('kinds.prepaid_cost')}</NativeSelectOption>
            </NativeSelect>
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('name')}</span>
            <Input className="mt-1" value={form.name} maxLength={500} onChange={(e) => set({ name: e.target.value })} placeholder={t('namePlaceholder')} />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('cost')}</span>
            <Input className="mt-1" inputMode="numeric" value={form.cost} onChange={(e) => set({ cost: e.target.value })} placeholder="36.000.000" />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('assetAccount')}</span>
            <Input className="mt-1 font-mono" value={form.assetAccount} onChange={(e) => set({ assetAccount: e.target.value })} />
          </label>
          {form.kind === 'fixed_asset' && (
            <label className="block text-xs">
              <span className="text-subtle-foreground">{t('accumulatedAccount')}</span>
              <Input className="mt-1 font-mono" value={form.accumulatedAccount} onChange={(e) => set({ accumulatedAccount: e.target.value })} />
            </label>
          )}
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('expenseAccount')}</span>
            <Input className="mt-1 font-mono" value={form.expenseAccount} onChange={(e) => set({ expenseAccount: e.target.value })} />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('startMonth')}</span>
            <DateInput kind="month" className="mt-1 w-full" value={form.startMonth} onChange={(startMonth) => set({ startMonth })} />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('months')}</span>
            <Input className="mt-1" inputMode="numeric" value={form.months} onChange={(e) => set({ months: e.target.value })} />
          </label>
        </div>
        {touched && problem && <ErrorText>{t(`formProblems.${problem}`)}</ErrorText>}
        {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Spinner className="text-current" /> : null}
            {t('add')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
            {root('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DepreciationCard({ slug, onClose }: { slug: string; onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('fixedAssets');
  const months = recentMonths(previousMonth(localToday()));
  const [month, setMonth] = useState(months[0] ?? '');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const request = useMutation(orpc.inbox.request.mutationOptions({ onSettled: () => void queryClient.invalidateQueries() }));

  if (request.data) {
    return (
      <Alert className="mb-6">
        <AlertDescription>
          {t('depreciationCreated', { month: monthLabel(month) })}{' '}
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: request.data.proposalId }} className="text-link underline">
            {t('viewProposal')}
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card className="mb-6 block p-4">
      <form
        className="space-y-4"
        aria-label={t('depreciationTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          request.mutate({ command: 'finance.depreciation.record', idempotencyKey, input: { month } });
        }}
      >
        <div>
          <h2 className="text-sm font-semibold">{t('depreciationTitle')}</h2>
          <p className="mt-1 text-xs text-subtle-foreground">{t('depreciationIntro')}</p>
        </div>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('month')}</span>
          <NativeSelect className="mt-1 w-36" value={month} onChange={(e) => setMonth(e.target.value)} disabled={request.isPending}>
            {months.map((m) => (
              <NativeSelectOption key={m} value={m}>
                {monthLabel(m)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {request.error && <ErrorText>{errorMessage(request.error)}</ErrorText>}
        <div className="flex gap-2">
          <Button type="submit" disabled={request.isPending}>
            {request.isPending ? <Spinner className="text-current" /> : null}
            {t('depreciationSubmit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={request.isPending}>
            {root('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// Stops a schedule early (disposed of, written off): the month given is the last that still counts.
function EndForm({ asset, onClose }: { asset: FixedAsset; onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('fixedAssets');
  const [month, setMonth] = useState(asset.lastPostedMonth ?? previousMonth(localToday()));
  const [reason, setReason] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const end = useMutation(orpc.fixedAssets.end.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3"
      aria-label={t('endTitle', { name: asset.name })}
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim() === '') return;
        end.mutate({ assetId: asset.id, month, reason: reason.trim(), idempotencyKey }, { onSuccess: onClose });
      }}
    >
      <label className="text-xs">
        <span className="text-subtle-foreground">{t('endMonth')}</span>
        <DateInput kind="month" className="mt-1 w-40" value={month} onChange={setMonth} />
      </label>
      <label className="grow text-xs">
        <span className="text-subtle-foreground">{t('endReason')}</span>
        <Input className="mt-1" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={t('endReasonPlaceholder')} />
      </label>
      <Button type="submit" size="sm" disabled={end.isPending || reason.trim() === ''}>
        {end.isPending ? <Spinner className="text-current" /> : null}
        {t('end')}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={end.isPending}>
        {root('common.cancel')}
      </Button>
      {end.error && <ErrorText>{errorMessage(end.error)}</ErrorText>}
    </form>
  );
}

export function FixedAssetsPage() {
  const t = useTranslations('fixedAssets');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const assets = useQuery(orpc.fixedAssets.list.queryOptions());
  const org = useQuery(orpc.org.get.queryOptions());
  const [adding, setAdding] = useState(false);
  const [depreciating, setDepreciating] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const canEnter = canEnterVoucher(org.data?.role);
  const rows = assets.data ?? [];

  const exportXlsx = useMutation({
    mutationFn: async () => {
      const response = await apiFetch('/api/export/fixed-assets.xlsx');
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('exportFile', { org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {canEnter && !adding && (
              <Button size="lg" variant="outline" onClick={() => setAdding(true)}>
                {t('new')}
              </Button>
            )}
            {canEnter && !depreciating && (
              <Button size="lg" variant="outline" onClick={() => setDepreciating(true)} disabled={rows.length === 0}>
                {t('depreciate')}
              </Button>
            )}
            <Button size="lg" onClick={() => exportXlsx.mutate()} disabled={exportXlsx.isPending || rows.length === 0}>
              {exportXlsx.isPending ? <Spinner className="text-current" /> : null}
              {t('export')}
            </Button>
          </div>
        }
      />
      {exportXlsx.error && <ErrorText>{errorMessage(exportXlsx.error)}</ErrorText>}
      {adding && <AssetFormCard onClose={() => setAdding(false)} />}
      {depreciating && <DepreciationCard slug={slug} onClose={() => setDepreciating(false)} />}
      {assets.isLoading ? (
        <Spinner />
      ) : assets.error ? (
        <ErrorText>{errorMessage(assets.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <DataTable head={[t('columns.name'), t('columns.accounts'), t('columns.schedule'), t('columns.cost'), t('columns.posted'), t('columns.remaining')]} numeric={[3, 4, 5]}>
          {rows.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="px-4 py-3 text-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  {a.name}
                  <Badge variant="outline">{t(`kinds.${a.kind}`)}</Badge>
                  {a.ended && <Badge variant="secondary">{t('ended', { month: monthLabel(a.ended.month) })}</Badge>}
                </div>
                {a.ended && <div className="mt-1 text-xs text-subtle-foreground">{a.ended.reason}</div>}
                {canEnter && !a.ended && ending !== a.id && (
                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setEnding(a.id)}>
                    {t('end')}
                  </Button>
                )}
                {ending === a.id && <EndForm asset={a} onClose={() => setEnding(null)} />}
              </TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">
                {[a.assetAccount, a.accumulatedAccount, a.expenseAccount].filter(Boolean).join(' · ')}
              </TableCell>
              <TableCell className="px-4 py-3 text-xs text-muted-foreground">
                {t('schedule', { start: monthLabel(a.startMonth), last: monthLabel(a.lastMonth), months: String(a.months) })}
                <div>{a.lastPostedMonth ? t('postedThrough', { month: monthLabel(a.lastPostedMonth), count: String(a.postedMonths) }) : t('notPosted')}</div>
              </TableCell>
              <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(a.cost)}</TableCell>
              <TableCell className="px-4 py-3 text-right text-muted-foreground tabular-nums">{f.money(a.posted)}</TableCell>
              <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(a.remaining)}</TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
