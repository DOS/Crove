import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Table, TableBody, TableCell, TableRow } from '@crove/ui/components/table';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { apiFetch, errorMessage, getCurrentOrg, orpc } from '../lib/api.ts';
import { useFormat } from '../i18n/provider.tsx';

export function JournalPage() {
  const t = useTranslations('journal');
  const f = useFormat();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const journal = useQuery(orpc.journal.list.queryOptions({ input: range }));

  const exportXlsx = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams(range);
      const response = await apiFetch(`/api/export/journal.xlsx?${params}`);
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
          <Button size="lg" onClick={() => exportXlsx.mutate()} disabled={exportXlsx.isPending || (journal.data?.length ?? 0) === 0}>
            {exportXlsx.isPending ? <Spinner /> : null}
            {t('export')}
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-subtle-foreground">
          {t('from')}
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-44" />
        </label>
        <label className="text-xs text-subtle-foreground">
          {t('to')}
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-44" />
        </label>
      </div>
      {exportXlsx.error && (
        <div className="mb-4">
          <ErrorText>{errorMessage(exportXlsx.error)}</ErrorText>
        </div>
      )}
      {journal.isLoading ? (
        <Spinner />
      ) : journal.error ? (
        <ErrorText>{errorMessage(journal.error)}</ErrorText>
      ) : (journal.data?.length ?? 0) === 0 ? (
        <Empty title={t('empty')} />
      ) : (
        <div className="space-y-3">
          {journal.data?.map((entry) => (
            <Card key={entry.id} className="block p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-foreground">{entry.description}</p>
                <p className="text-xs text-subtle-foreground">{f.date(entry.entryDate)}</p>
              </div>
              <Table className="mt-2">
                <TableBody>
                  {entry.lines.map((l) => (
                    <TableRow key={l.lineNo} className="hover:bg-transparent">
                      <TableCell className="px-0 py-1.5 whitespace-normal text-muted-foreground">
                        <span className="font-mono text-foreground">{l.accountCode}</span> {l.accountName}
                      </TableCell>
                      <TableCell className="w-36 px-0 py-1.5 text-right text-foreground tabular-nums">{l.debit !== '0' && l.debit !== '0.0000' ? f.money(l.debit) : ''}</TableCell>
                      <TableCell className="w-36 px-0 py-1.5 text-right text-foreground tabular-nums">{l.credit !== '0' && l.credit !== '0.0000' ? f.money(l.credit) : ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
