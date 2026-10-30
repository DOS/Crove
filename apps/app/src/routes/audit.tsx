// The org's audit log for owners and admins (#672): every command's audit row, newest first, filtered by who, what,
// outcome, object and days, a page at a time, and the filtered list as a CSV file (the server builds and audits it).
// Commands show by their label in the screen's language, with the name under it (#1654); the file gets a label column.
// The filters start from the URL (#1445), so a link opens it filtered: a proposal's decision links here by its id, and
// the log then lists the decision and the rows of what it ran.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useLocale, useMessages, useTranslations } from 'use-intl';
import { AUDIT_OUTCOMES, type AuditCursor, type AuditFilter, type AuditOutcome, type AuditPage } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DateInput } from '../components/date-input.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { auditFilter, auditForm, commandLabel, nextAuditCursor, withCommandLabels, type AuditFilterForm, type AuditSearch } from '../lib/audit.ts';

const OUTCOME_BADGE: Record<AuditOutcome, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  ok: 'success',
  pending_approval: 'secondary',
  denied: 'warning',
  failed: 'destructive',
};

const EMPTY: AuditFilterForm = { actor: '', command: '', outcome: '', target: '', targetType: '', from: '', to: '' };

// A command by its label, with its name under it for whoever searches the code or the file; a name with no label (a
// command no longer registered) as it is.
function CommandName({ label, name }: { label: string | null; name: string }) {
  if (label === null) return <span className="font-mono text-xs">{name}</span>;
  return (
    <>
      {label}
      <p className="font-mono text-xs text-subtle-foreground">{name}</p>
    </>
  );
}

// The filters of the URL start the screen's form; another link to the screen starts it again.
export function AuditPage() {
  const search: AuditSearch = useSearch({ strict: false });
  return <AuditLog key={JSON.stringify(search)} search={search} />;
}

function AuditLog({ search }: { search: AuditSearch }) {
  const t = useTranslations('audit');
  const f = useFormat();
  const locale = useLocale();
  const labels = useMessages().commands;
  const org = useQuery(orpc.org.get.queryOptions());
  const canRead = org.data?.role === 'owner' || org.data?.role === 'admin';
  const [form, setForm] = useState<AuditFilterForm>(() => auditForm(search));
  const filter: AuditFilter = auditFilter(form);
  const commands = useQuery({ ...orpc.org.auditCommands.queryOptions(), enabled: canRead });
  const commandOptions = (commands.data ?? [])
    .map((name) => ({ name, label: commandLabel(labels, name) ?? name }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  // A page at a time (the server sends at most AUDIT_PAGE_SIZE); Load more asks for the rows after the last one.
  const log = useInfiniteQuery({
    ...orpc.org.audit.infiniteOptions({
      input: (before: AuditCursor | undefined) => ({ ...filter, ...(before ? { before } : {}) }),
      initialPageParam: undefined as AuditCursor | undefined,
      getNextPageParam: (page: AuditPage) => nextAuditCursor(page),
      placeholderData: keepPreviousData,
    }),
    enabled: canRead,
  });
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  const exportCsv = useMutation({
    mutationFn: () => client.org.auditExport(filter),
    onSuccess: (file) => {
      const csv = withCommandLabels(file.csv, (name) => commandLabel(labels, name));
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      // Some browsers still read the link a moment after the click.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  });
  // A changed target id drops the type a link gave it.
  const set = (key: keyof AuditFilterForm) => (e: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value, ...(key === 'target' ? { targetType: '' } : {}) }));

  if (org.isLoading) return <Spinner />;
  if (org.error) return <ErrorText>{errorMessage(org.error)}</ErrorText>;
  if (!canRead) return <Empty title={t('forbidden')} />;

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button size="lg" variant="outline" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending}>
            {exportCsv.isPending ? <Spinner className="text-current" /> : null}
            {t('export')}
          </Button>
        }
      />
      {exportCsv.error && (
        <div className="mb-4">
          <ErrorText>{errorMessage(exportCsv.error)}</ErrorText>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('filterActor')}</span>
          <NativeSelect className="mt-1 w-52" value={form.actor} onChange={set('actor')}>
            <NativeSelectOption value="">{t('anyone')}</NativeSelectOption>
            {org.data?.members.map((m) => (
              <NativeSelectOption key={m.userId} value={m.userId}>
                {m.displayName ?? m.email}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="system">{t('system')}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('filterCommand')}</span>
          <NativeSelect className="mt-1 w-64" value={form.command} onChange={set('command')}>
            <NativeSelectOption value="">{t('anyCommand')}</NativeSelectOption>
            {commandOptions.map((c) => (
              <NativeSelectOption key={c.name} value={c.name}>
                {c.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('filterOutcome')}</span>
          <NativeSelect className="mt-1 w-40" value={form.outcome} onChange={set('outcome')}>
            <NativeSelectOption value="">{t('anyOutcome')}</NativeSelectOption>
            {AUDIT_OUTCOMES.map((o) => (
              <NativeSelectOption key={o} value={o}>
                {t(`outcomes.${o}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('filterTarget')}</span>
          <Input value={form.target} onChange={set('target')} placeholder={t('targetHint')} className="mt-1 w-72 font-mono" />
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('from')}</span>
          <DateInput value={form.from} onChange={(value) => set('from')({ target: { value } })} className="mt-1 w-44" />
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('to')}</span>
          <DateInput value={form.to} onChange={(value) => set('to')({ target: { value } })} className="mt-1 w-44" />
        </label>
        {Object.values(form).some((v) => v !== '') && (
          <Button variant="ghost" size="sm" onClick={() => setForm(EMPTY)}>
            {t('clear')}
          </Button>
        )}
      </div>
      {form.target.trim() !== '' && !filter.targetId && <p className="mb-3 text-xs text-warning">{t('targetInvalid')}</p>}
      {filter.targetType && <p className="mb-3 text-xs text-subtle-foreground">{t('targetTypeOnly', { type: filter.targetType })}</p>}
      {log.isLoading ? (
        <TableSkeleton columns={5} />
      ) : log.error && rows.length === 0 ? (
        <ErrorText>{errorMessage(log.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={t('empty')} />
      ) : (
        <>
          <DataTable head={[t('columns.at'), t('columns.actor'), t('columns.command'), t('columns.outcome'), t('columns.target'), t('columns.detail')]}>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="px-4 py-3 whitespace-nowrap text-muted-foreground">{f.dateTime(r.at)}</TableCell>
                <TableCell className="px-4 py-3 text-foreground">
                  {r.actorType === 'system' ? t('system') : (r.actorName ?? t('former'))}
                  {r.actorType === 'agent' && <p className="text-xs text-subtle-foreground">{t('agent')}</p>}
                </TableCell>
                <TableCell className="px-4 py-3 text-foreground">
                  <CommandName label={commandLabel(labels, r.command)} name={r.command} />
                </TableCell>
                <TableCell className="px-4 py-3">
                  <Badge variant={OUTCOME_BADGE[r.outcome]}>{t(`outcomes.${r.outcome}`)}</Badge>
                </TableCell>
                <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {r.targetType && <span className="block">{r.targetType}</span>}
                  {r.targetId && (
                    <button type="button" className="text-link hover:underline" onClick={() => setForm((prev) => ({ ...prev, target: r.targetId ?? '', targetType: '' }))}>
                      {r.targetId.slice(0, 8)}
                    </button>
                  )}
                </TableCell>
                <TableCell className="max-w-md px-4 py-3 text-xs break-words text-muted-foreground">{r.detail}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          {log.error && (
            <div className="mt-3">
              <ErrorText>{errorMessage(log.error)}</ErrorText>
            </div>
          )}
          {log.hasNextPage && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-xs text-muted-foreground">{t('more', { count: String(rows.length) })}</p>
              <Button variant="outline" size="sm" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
