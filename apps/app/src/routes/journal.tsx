import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button, Card, Empty, ErrorText, Input, PageHeader, Spinner } from '../components/ui.tsx';
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
          <Button variant="primary" onClick={() => exportXlsx.mutate()} disabled={exportXlsx.isPending || (journal.data?.length ?? 0) === 0}>
            {exportXlsx.isPending ? <Spinner /> : null}
            {t('export')}
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-fg-3">
          {t('from')}
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-44" />
        </label>
        <label className="text-xs text-fg-3">
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
            <Card key={entry.id} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-fg">{entry.description}</p>
                <p className="text-xs text-fg-3">{f.date(entry.entryDate)}</p>
              </div>
              <table className="mt-2 w-full text-sm">
                <tbody className="divide-y divide-[var(--line)]">
                  {entry.lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className="py-1.5 text-fg-2">
                        <span className="font-mono text-fg">{l.accountCode}</span> {l.accountName}
                      </td>
                      <td className="tabular w-36 py-1.5 text-right text-fg">{l.debit !== '0' && l.debit !== '0.0000' ? f.money(l.debit) : ''}</td>
                      <td className="tabular w-36 py-1.5 text-right text-fg">{l.credit !== '0' && l.credit !== '0.0000' ? f.money(l.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
