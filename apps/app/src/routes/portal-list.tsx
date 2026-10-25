import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { ReconcileOutcome } from '@crove/kernel-contract';
import { Alert, AlertDescription, AlertTitle } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { PortalSyncPanel } from '../components/portal-sync.tsx';
import { getConfig } from '../lib/auth.ts';
import { canSyncFromPortal } from '../lib/portal-sync.ts';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import {
  SECTIONS,
  canImportPortalList,
  formatPeriod,
  invoiceLabel,
  itemsByOutcome,
  mailFailed,
  outcomeTotal,
  pickProblem,
  pollWhilePending,
  pollWhileSending,
  type ReconcileItem,
} from '../lib/portal-list.ts';
import { defaultPeriod, periodKey, switchKind, yearOptions, type PeriodChoice, type PeriodKind } from '../lib/vat.ts';

const SKIPPED_SHOWN = 20;

function ItemRow({ item, slug }: { item: ReconcileItem; slug: string }) {
  const t = useTranslations('portalList');
  const f = useFormat();
  const invoice = item.portal ?? item.crove;
  if (!invoice) return null;
  const sellerName = item.portal?.sellerName || item.crove?.sellerName || '';
  const sellerTaxCode = item.portal?.sellerTaxCode ?? item.crove?.sellerTaxCode ?? null;
  const notes: string[] = [];
  // A declared_late item is outside the period by definition; its section says so, and the note gives its posting date.
  if (item.outsidePeriod && item.outcome !== 'declared_late') notes.push(t('notes.outsidePeriod'));
  if (item.outcome === 'declared_late' && item.crove?.postingDate) notes.push(t('notes.postedOn', { date: f.date(item.crove.postingDate) }));
  if (item.declaredInLaterPeriod && item.crove?.postingDate) notes.push(t('notes.declaredInLaterPeriod', { date: f.date(item.crove.postingDate) }));
  if (item.withoutTaxCode) notes.push(t('notes.withoutTaxCode'));
  if (item.duplicateInCrove) notes.push(t('notes.duplicateInCrove'));
  if (item.duplicateRows > 0) notes.push(t('notes.duplicateRows', { count: item.duplicateRows }));
  for (const d of item.differences) notes.push(t(`differences.${d}`));
  return (
    <TableRow>
      <TableCell className="px-4 py-3 text-muted-foreground">{f.date(invoice.issueDate)}</TableCell>
      <TableCell className="px-4 py-3 font-mono text-xs text-foreground">{invoiceLabel(invoice)}</TableCell>
      <TableCell className="px-4 py-3 text-foreground">
        {sellerName}
        {sellerTaxCode && <span className="block font-mono text-xs text-subtle-foreground">{sellerTaxCode}</span>}
      </TableCell>
      <TableCell className="px-4 py-3 text-foreground tabular-nums">
        {item.portal?.total != null ? f.money(item.portal.total, item.portal.currency) : <span className="text-subtle-foreground">{t('noAmount')}</span>}
      </TableCell>
      <TableCell className="px-4 py-3 text-foreground tabular-nums">{item.crove ? f.money(item.crove.total, item.crove.currency) : '-'}</TableCell>
      <TableCell className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1">
          {item.portal?.statusLabel && <Badge variant={item.portal.status === 'cancelled' || item.portal.status === 'replaced' ? 'destructive' : 'outline'}>{item.portal.statusLabel}</Badge>}
          {notes.map((n) => (
            <Badge key={n} variant="warning">
              {n}
            </Badge>
          ))}
          {item.crove?.kind === 'proposal' && (
            <Link to="/o/$slug/inbox/$id" params={{ slug, id: item.crove.id }} className="text-xs text-link underline-offset-4 hover:underline">
              {t('openProposal')}
            </Link>
          )}
          {item.crove?.kind === 'document' && (
            <Link to="/o/$slug/documents" params={{ slug }} className="text-xs text-link underline-offset-4 hover:underline">
              {t('openDocuments')}
            </Link>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function Section({ outcome, items, total, folded, slug }: { outcome: ReconcileOutcome; items: ReconcileItem[]; total: number; folded: boolean; slug: string }) {
  const t = useTranslations('portalList');
  // The server lists the first items of a long section; the count and the summary still cover all of them.
  const truncated = total > items.length ? <p className="mt-2 text-sm text-muted-foreground">{t('truncatedSection', { shown: items.length, total })}</p> : null;
  const table = (
    <DataTable head={[t('columns.issueDate'), t('columns.invoice'), t('columns.seller'), t('columns.portalTotal'), t('columns.croveTotal'), t('columns.notes')]}>
      {items.map((item) => (
        <ItemRow key={`${item.portal?.listId ?? 'crove'}-${item.portal?.rowNo ?? item.crove?.id}`} item={item} slug={slug} />
      ))}
    </DataTable>
  );
  const title = t(`sections.${outcome}.title`, { count: String(total) });
  if (folded) {
    return (
      <details className="group">
        <summary className="cursor-pointer text-base font-semibold text-foreground">{title}</summary>
        <p className="mt-1 mb-2 text-sm text-muted-foreground">{t(`sections.${outcome}.hint`)}</p>
        {table}
        {truncated}
      </details>
    );
  }
  return (
    <section>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-1 mb-2 text-sm text-muted-foreground">{t(`sections.${outcome}.hint`)}</p>
      {table}
      {truncated}
    </section>
  );
}

const REMINDER_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

// Asking the company for the invoices the portal lists and Crove lacks (issue #669): one email for the period, to the
// company's contact email (Settings), and an optional monthly reminder. Editors send and set the reminder; everyone
// sees what was sent.
function MissingInvoiceRequest({ period, missing, editor, canManage, slug }: { period: string; missing: number; editor: boolean; canManage: boolean; slug: string }) {
  const t = useTranslations('portalList.request');
  const f = useFormat();
  const status = useQuery({ ...orpc.missingInvoices.status.queryOptions(), refetchInterval: (q) => pollWhileSending(q.state.data) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.missingInvoices.status.key() });
  const send = useMutation(orpc.missingInvoices.request.mutationOptions({ onSettled: refresh }));
  // The invoices missing from the books of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const reminder = useMutation(orpc.missingInvoices.setReminder.mutationOptions({ onSettled: refresh }));
  const data = status.data;
  if (status.isLoading) return <Spinner />;
  if (status.error) return <ErrorText>{errorMessage(status.error)}</ErrorText>;
  if (!data) return null;
  const contact = data.contactEmail;
  return (
    <Card className="block p-4" role="region" aria-label={t('title')}>
      <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
      {missing === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">{t('introNone')}</p>
      ) : contact ? (
        <p className="mt-1 text-sm text-muted-foreground">{t('intro', { email: contact, count: missing })}</p>
      ) : (
        <Alert className="mt-2 border-warning/30 bg-warning/10 text-warning">
          <AlertTitle>{t('noContact')}</AlertTitle>
          <AlertDescription>
            {canManage ? (
              <Link to="/o/$slug/settings" params={{ slug }} className="text-link underline-offset-4 hover:underline">
                {t('noContactManage')}
              </Link>
            ) : (
              t('noContactAsk')
            )}
          </AlertDescription>
        </Alert>
      )}
      {editor && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {missing > 0 && contact && (
            <Button
              onClick={() => {
                send.reset();
                send.mutate({ period, legalEntityId: entity.legalEntityId });
              }}
              disabled={send.isPending || !entity.ready}
            >
              {send.isPending ? <Spinner className="text-current" /> : null}
              {t('send')}
            </Button>
          )}
          <label className="text-xs">
            <span className="text-subtle-foreground">{t('reminder')}</span>
            <NativeSelect
              aria-label={t('reminder')}
              className="mt-1 w-36"
              value={data.reminderDay ?? ''}
              disabled={reminder.isPending}
              onChange={(e) => reminder.mutate({ day: e.target.value ? Number(e.target.value) : null })}
            >
              <NativeSelectOption value="">{t('reminderOff')}</NativeSelectOption>
              {REMINDER_DAYS.map((day) => (
                // Without a contact email the reminder can only be turned off (the kernel refuses a day with CONTACT_EMAIL_REQUIRED).
                <NativeSelectOption key={day} value={day} disabled={!contact}>
                  {t('reminderDay', { day: String(day) })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        </div>
      )}
      {send.data && (
        <p role="status" className={`mt-2 text-sm ${send.data.status === 'suppressed' ? 'text-warning' : 'text-muted-foreground'}`}>
          {send.data.status === 'suppressed' ? t('suppressed') : t('queued')}
        </p>
      )}
      {(send.error || reminder.error) && (
        <div className="mt-2">
          <ErrorText>{errorMessage(send.error ?? reminder.error)}</ErrorText>
        </div>
      )}
      <p className="mt-2 text-xs text-subtle-foreground">{data.reminderDay !== null ? t('reminderOn', { day: String(data.reminderDay) }) : t('reminderHint')}</p>
      {!contact && editor && <p className="mt-1 text-xs text-subtle-foreground">{t('reminderNeedsContact')}</p>}
      {data.mails.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-foreground">{t('historyTitle')}</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {data.mails.map((mail) => (
              <li key={mail.id} className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span>{f.dateTime(mail.createdAt)}</span>
                <span className="text-foreground">{t(`kind.${mail.kind}`)}</span>
                {mail.periods.length > 0 && <span>{mail.periods.map(formatPeriod).join(', ')}</span>}
                {mail.count !== null && <span>{t('invoices', { count: mail.count })}</span>}
                <Badge variant={mailFailed(mail.status) ? 'warning' : mail.status === 'sent' || mail.status === 'delivered' ? 'success' : 'outline'}>{t(`status.${mail.status}`)}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// Reconciliation with the tax portal's purchase list (issue #465): pick the period, upload the .xlsx exported from
// hoadondientu.gdt.gov.vn, and see which invoices the tax authority has that Crove lacks, and the other way round.
export function PortalListPage() {
  const t = useTranslations('portalList');
  const tv = useTranslations('vat');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const org = useQuery(orpc.org.get.queryOptions());
  const [choice, setChoice] = useState<PeriodChoice>(() => defaultPeriod('month'));
  const period = periodKey(choice);
  // The portal's list against the books of the entity chosen in the shell (#1280); an imported list is for it too.
  const entity = useChosenEntity();
  const report = useQuery({
    ...orpc.portalList.reconcile.queryOptions({ input: { period, legalEntityId: entity.legalEntityId } }),
    enabled: entity.ready,
    refetchInterval: (q) => pollWhilePending(q.state.data),
  });
  const data = report.data;
  const editor = canImportPortalList(org.data?.role);
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<'not_xlsx' | 'too_large' | null>(null);
  // The assisted sync from the tax portal (issue #325), when the deployment turned it on.
  const canSync = canSyncFromPortal(org.data?.role, getConfig().taxPortalSync);
  const [syncOpen, setSyncOpen] = useState(false);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.portalList.reconcile.key() });
  const importList = useMutation({
    mutationFn: async (file: File) => {
      const uploaded = await uploadFiles([file], 'import');
      const fileId = uploaded.files[0]?.fileId;
      if (!fileId) throw new Error(t('uploadFailed'));
      return client.portalList.import({ period, fileId, legalEntityId: entity.legalEntityId });
    },
    onSettled: refresh,
  });
  const removeList = useMutation(orpc.portalList.remove.mutationOptions({ onSettled: refresh }));

  const choose = (file: File | undefined) => {
    if (input.current) input.current.value = '';
    importList.reset();
    if (!file) return;
    const found = pickProblem(file);
    setProblem(found);
    if (!found) importList.mutate(file);
  };

  const indexes = choice.kind === 'month' ? Array.from({ length: 12 }, (_, i) => i + 1) : [1, 2, 3, 4];
  const grouped = data ? itemsByOutcome(data.items) : new Map();
  const doneLists = data?.lists.filter((l) => l.status === 'done') ?? [];
  // Rows of the period's lists that name an invoice but could not be read: the comparison misses them.
  const skipped = doneLists.flatMap((l) => l.skipped.map((s) => ({ ...s, filename: l.filename })));
  const skippedTotal = doneLists.reduce((sum, l) => sum + l.skippedCount, 0);
  // Rows left out as not the org's purchases (its own sales, another buyer): expected on a mixed export, but a misread
  // buyer code would hide a purchase, so they are shown next to the skipped rows (#506).
  const droppedLists = doneLists.filter((l) => l.ownSalesCount + l.otherBuyerCount > 0);
  const droppedTotal = droppedLists.reduce((sum, l) => sum + l.ownSalesCount + l.otherBuyerCount, 0);

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          editor ? (
            <>
              {canSync && (
                <Button size="lg" variant="outline" onClick={() => setSyncOpen(true)} disabled={syncOpen}>
                  {t('sync.open')}
                </Button>
              )}
              <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" aria-label={t('upload')} onChange={(e) => choose(e.target.files?.[0])} />
              <Button size="lg" onClick={() => input.current?.click()} disabled={importList.isPending || !entity.ready}>
                {importList.isPending ? <Spinner className="text-current" /> : null}
                {t('upload')}
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="text-subtle-foreground">{tv('kind')}</span>
          <NativeSelect aria-label={tv('kind')} className="mt-1 w-32" value={choice.kind} onChange={(e) => setChoice(switchKind(choice, e.target.value as PeriodKind))}>
            <NativeSelectOption value="month">{tv('month')}</NativeSelectOption>
            <NativeSelectOption value="quarter">{tv('quarter')}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{choice.kind === 'month' ? tv('month') : tv('quarter')}</span>
          <NativeSelect
            aria-label={choice.kind === 'month' ? tv('month') : tv('quarter')}
            className="mt-1 w-28"
            value={choice.index}
            onChange={(e) => setChoice({ ...choice, index: Number(e.target.value) })}>
            {indexes.map((n) => (
              <NativeSelectOption key={n} value={n}>
                {choice.kind === 'month' ? tv('monthOption', { n: String(n) }) : tv('quarterOption', { n: String(n) })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{tv('year')}</span>
          <NativeSelect aria-label={tv('year')} className="mt-1 w-28" value={choice.year} onChange={(e) => setChoice({ ...choice, year: Number(e.target.value) })}>
            {yearOptions().map((y) => (
              <NativeSelectOption key={y} value={y}>
                {y}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {data && <p className="pb-1.5 text-sm text-muted-foreground">{t('range', { from: f.date(data.period.from), to: f.date(data.period.to) })}</p>}
      </div>

      {canSync && syncOpen && (
        <div className="mb-6">
          <PortalSyncPanel key={period} period={period} periodLabel={formatPeriod(period)} onChanged={refresh} onClose={() => setSyncOpen(false)} />
        </div>
      )}

      {problem && (
        <div className="mb-4">
          <ErrorText>{t(`pickProblems.${problem}`)}</ErrorText>
        </div>
      )}
      {(importList.error || removeList.error) && (
        <div className="mb-4">
          <ErrorText>{errorMessage(importList.error ?? removeList.error)}</ErrorText>
        </div>
      )}

      {report.isPending ? (
        <Spinner />
      ) : report.error ? (
        <ErrorText>{errorMessage(report.error)}</ErrorText>
      ) : data ? (
        <div className="space-y-8">
          <Card className="block p-4">
            <h2 className="text-sm font-medium text-foreground">{t('howTitle')}</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('how.login')}</li>
              <li>{t('how.search')}</li>
              <li>{t('how.export')}</li>
              <li>{t('how.upload')}</li>
            </ol>
          </Card>

          <section>
            <h2 className="mb-2 text-base font-semibold text-foreground">{t('listsTitle', { count: String(data.lists.length) })}</h2>
            {data.lists.length === 0 ? (
              <Empty title={t('noLists')} hint={t('noListsHint')} />
            ) : (
              <DataTable head={[t('columns.file'), t('columns.importedAt'), t('columns.listRange'), t('columns.status'), '']}>
                {data.lists.map((list) => (
                  <TableRow key={list.id}>
                    <TableCell className="px-4 py-3 text-foreground">{list.filename}</TableCell>
                    <TableCell className="px-4 py-3 text-muted-foreground">{f.dateTime(list.createdAt)}</TableCell>
                    <TableCell className="px-4 py-3 text-muted-foreground">
                      {list.listFrom && list.listTo ? t('listRange', { from: f.date(list.listFrom), to: f.date(list.listTo) }) : '-'}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      {list.status === 'pending' ? (
                        <Badge variant="brand">{t('listStatus.pending')}</Badge>
                      ) : list.status === 'done' ? (
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="success">{t('listStatus.done', { count: list.rowCount ?? 0 })}</Badge>
                          {list.skippedCount > 0 && <Badge variant="warning">{t('listStatus.skipped', { count: list.skippedCount })}</Badge>}
                          {list.ownSalesCount > 0 && <Badge variant="outline">{t('listStatus.ownSales', { count: list.ownSalesCount })}</Badge>}
                          {list.otherBuyerCount > 0 && <Badge variant="outline">{t('listStatus.otherBuyers', { count: list.otherBuyerCount })}</Badge>}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <Badge variant="destructive">{t('listStatus.failed')}</Badge>
                          {list.error && <p className="text-xs text-destructive">{list.error}</p>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right">
                      {editor && (
                        <Button variant="ghost" size="sm" disabled={removeList.isPending} onClick={() => removeList.mutate({ listId: list.id })}>
                          {t('remove')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </DataTable>
            )}
          </section>

          {doneLists.length > 0 && (
            <>
              {skippedTotal > 0 && (
                <Alert role="alert" className="border-warning/30 bg-warning/10 text-warning">
                  <AlertTitle>{t('incompleteTitle', { count: skippedTotal })}</AlertTitle>
                  <AlertDescription>
                    <p>{t('incompleteHint')}</p>
                    <ul className="mt-1 list-disc pl-5">
                      {skipped.slice(0, SKIPPED_SHOWN).map((s) => (
                        <li key={`${s.filename}-${s.rowNo}`}>{t('skippedRow', { file: s.filename, row: String(s.rowNo), reason: t(`skipReasons.${s.reason}`) })}</li>
                      ))}
                    </ul>
                    {skippedTotal > Math.min(skipped.length, SKIPPED_SHOWN) && <p className="mt-1">{t('skippedMore', { count: skippedTotal - Math.min(skipped.length, SKIPPED_SHOWN) })}</p>}
                  </AlertDescription>
                </Alert>
              )}
              {droppedTotal > 0 && (
                <Alert>
                  <AlertTitle>{t('droppedTitle', { count: droppedTotal })}</AlertTitle>
                  <AlertDescription>
                    <p>{t('droppedHint')}</p>
                    <ul className="mt-1 list-disc pl-5">
                      {droppedLists.flatMap((l) => [
                        ...(l.ownSalesCount > 0 ? [<li key={`${l.id}-own`}>{t('droppedOwnSales', { file: l.filename, count: l.ownSalesCount })}</li>] : []),
                        ...(l.otherBuyerCount > 0 ? [<li key={`${l.id}-other`}>{t('droppedOtherBuyers', { file: l.filename, count: l.otherBuyerCount })}</li>] : []),
                      ])}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              <section aria-label={t('summaryTitle')} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    ['missing', data.summary.missing],
                    ['amount_mismatch', data.summary.amountMismatch],
                    ['void_in_crove', data.summary.voidInCrove],
                    ['not_on_portal', data.summary.notOnPortal],
                  ] as const
                ).map(([outcome, count]) => (
                  <Card key={outcome} className="block p-4">
                    <p className="text-xs text-subtle-foreground">{t(`tiles.${outcome}`)}</p>
                    <p className={`mt-1 text-2xl font-semibold tabular-nums ${count > 0 ? 'text-warning' : 'text-foreground'}`}>{f.number(count)}</p>
                  </Card>
                ))}
              </section>
              <p className="text-sm text-muted-foreground">
                {t('summaryLine', { portal: data.summary.portalInvoices, matched: data.summary.matched, inbox: data.summary.inInbox })}
              </p>
              <MissingInvoiceRequest key={`${period}:${entity.legalEntityId ?? ''}`} period={period} missing={data.summary.missing} editor={editor} canManage={org.data?.role === 'owner' || org.data?.role === 'admin'} slug={slug} />
              {SECTIONS.map(({ outcome, folded }) => {
                const items = grouped.get(outcome) ?? [];
                return items.length > 0 ? <Section key={outcome} outcome={outcome} items={items} total={outcomeTotal(data.summary, outcome)} folded={folded} slug={slug} /> : null;
              })}
              {data.items.length > 0 && data.summary.missing + data.summary.amountMismatch + data.summary.voidInCrove + data.summary.notOnPortal === 0 && (
                <Empty title={t('allClear')} hint={t('allClearHint')} />
              )}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
