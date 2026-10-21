// A person's data under the PDPL (#923), for owners and admins: look up an email address, a phone number, or a tax
// code or national ID, see every row of the org that holds it and what an erasure would do to each, and download the
// rows as JSON for the person's request to see their data.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { PersonalDataResult } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const HANDLING_BADGE = { erase: 'warning', keep_legal: 'secondary', keep_org: 'secondary' } as const;

function download(value: string, result: PersonalDataResult) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ value, ...result }, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `personal-data-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  // Some browsers still read the link a moment after the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PersonalDataPage() {
  const t = useTranslations('personalData');
  const org = useQuery(orpc.org.get.queryOptions());
  const canRead = org.data?.role === 'owner' || org.data?.role === 'admin';
  const [draft, setDraft] = useState('');
  const [value, setValue] = useState('');
  const found = useQuery({ ...orpc.org.personalData.queryOptions({ input: { value } }), enabled: canRead && value.length >= 3, retry: false });

  if (org.isLoading) return <Spinner />;
  if (org.error) return <ErrorText>{errorMessage(org.error)}</ErrorText>;
  if (!canRead) return <Empty title={t('forbidden')} />;

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <form
        className="mb-4 flex max-w-xl flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setValue(draft.trim());
        }}
      >
        <Input className="min-w-64 flex-1" placeholder={t('placeholder')} aria-label={t('placeholder')} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" disabled={draft.trim().length < 3}>
          {t('search')}
        </Button>
        {found.data && found.data.matches.length > 0 && (
          <Button type="button" variant="outline" onClick={() => download(value, found.data)}>
            {t('download')}
          </Button>
        )}
      </form>
      <p className="mb-4 max-w-3xl text-xs text-muted-foreground">{t('hint')}</p>
      {found.isFetching ? (
        <Spinner />
      ) : found.error ? (
        <ErrorText>{errorMessage(found.error)}</ErrorText>
      ) : !found.data ? null : found.data.matches.length === 0 ? (
        <Empty title={t('none')} />
      ) : (
        <>
          {found.data.truncated && <p className="mb-2 text-sm text-warning">{t('truncated')}</p>}
          <DataTable head={[t('columns.where'), t('columns.handling'), t('columns.reason'), t('columns.row')]}>
            {found.data.matches.map((m, i) => (
              <TableRow key={`${m.column}-${m.rowId ?? i}`}>
                <TableCell className="px-4 py-3 font-mono text-xs text-foreground">{m.column}</TableCell>
                <TableCell className="px-4 py-3">
                  <Badge variant={HANDLING_BADGE[m.handling]}>{t(`handling.${m.handling}`)}</Badge>
                </TableCell>
                <TableCell className="px-4 py-3 text-xs text-muted-foreground">{m.reason}</TableCell>
                <TableCell className="px-4 py-3 font-mono text-xs text-subtle-foreground">{m.rowId ?? '-'}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        </>
      )}
    </>
  );
}
