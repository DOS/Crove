// A person's data under the PDPL (#923), for owners and admins: look up an email address, a phone number, or a tax
// code or national ID, see every row of the org that holds it and what an erasure would do to each, and download the
// rows as JSON for the person's request to see their data. An owner can then erase it (R3: a fresh second factor),
// after confirming; the result lists what was erased and what the law or a record keeps. Members' private notes and
// to-dos that mention the value are only counted, per author, never shown (#1678, ADR-0037).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { PersonalDataResult } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';

const HANDLING_BADGE = { erase: 'warning', keep_legal: 'secondary', keep_org: 'secondary', keep_record: 'secondary' } as const;

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
  const isOwner = org.data?.role === 'owner';
  const [confirming, setConfirming] = useState(false);
  // One key per confirmed erasure: a retry after the second factor returns the same result.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const erase = useMutation(
    orpc.org.personalDataErase.mutationOptions({
      onSuccess: () => {
        setConfirming(false);
        void queryClient.invalidateQueries();
      },
    }),
  );
  const eraseNow = () => erase.mutate({ value, idempotencyKey });
  const hasErasable = found.data?.matches.some((m) => m.handling === 'erase') ?? false;
  const hasAny = (found.data?.matches.length ?? 0) > 0 || (found.data?.privateItems.length ?? 0) > 0;
  const nameOf = (userId: string) => {
    const member = org.data?.members.find((m) => m.userId === userId);
    return member ? (member.displayName ?? member.email) : t('formerMember');
  };
  const items = (notes: number, todos: number) =>
    [notes > 0 ? t('privateNotes', { count: notes }) : null, todos > 0 ? t('privateTodos', { count: todos }) : null].filter(Boolean).join(` ${t('and')} `);

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
          erase.reset();
          setConfirming(false);
          setIdempotencyKey(crypto.randomUUID());
        }}
      >
        <Input className="min-w-64 flex-1" placeholder={t('placeholder')} aria-label={t('placeholder')} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" disabled={draft.trim().length < 3}>
          {t('search')}
        </Button>
        {found.data && hasAny && (
          <Button type="button" variant="outline" onClick={() => download(value, found.data)}>
            {t('download')}
          </Button>
        )}
      </form>
      <p className="mb-4 max-w-3xl text-xs text-muted-foreground">{t('hint')}</p>
      {erase.data && (
        <div className="mb-4 max-w-3xl space-y-1 rounded-lg border p-3 text-sm">
          <p className="font-medium text-foreground">{t('erased')}</p>
          {erase.data.erased.map((e) => (
            <p key={e.column} className="font-mono text-xs text-muted-foreground">
              {t('erasedRow', { column: e.column, rows: e.rows })}
            </p>
          ))}
          {erase.data.kept.length > 0 && <p className="pt-2 font-medium text-foreground">{t('kept')}</p>}
          {erase.data.kept.map((k) => (
            <p key={k.column} className="text-xs text-muted-foreground">
              {t('keptRow', { column: k.column, rows: k.rows, reason: k.reason })}
            </p>
          ))}
        </div>
      )}
      {isOwner && hasErasable && !erase.data && (
        <div className="mb-4 max-w-3xl space-y-2">
          {!confirming ? (
            <Button variant="destructive" onClick={() => setConfirming(true)}>
              {t('erase')}
            </Button>
          ) : (
            <div className="space-y-2 rounded-lg border border-destructive p-3">
              <p className="text-sm text-foreground">{t('eraseConfirm', { value })}</p>
              <div className="flex gap-2">
                <Button variant="destructive" disabled={erase.isPending} onClick={eraseNow}>
                  {erase.isPending ? <Spinner className="text-current" /> : null}
                  {t('eraseNow')}
                </Button>
                <Button variant="ghost" disabled={erase.isPending} onClick={() => setConfirming(false)}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          )}
          {erase.error &&
            (isStepUpRequired(erase.error) ? (
              <StepUpPrompt action={t('stepUpErase')} onVerified={eraseNow} onCancel={() => erase.reset()} />
            ) : (
              <ErrorText>{errorMessage(erase.error)}</ErrorText>
            ))}
        </div>
      )}
      {found.isFetching ? (
        <Spinner />
      ) : found.error ? (
        <ErrorText>{errorMessage(found.error)}</ErrorText>
      ) : !found.data ? null : !hasAny ? (
        <Empty title={t('none')} />
      ) : (
        <>
          {found.data.privateItems.length > 0 && (
            <div className="mb-4 max-w-3xl space-y-1 rounded-lg border p-3 text-sm" data-testid="private-items">
              <p className="font-medium text-foreground">
                {t('privateSummary', {
                  items: items(
                    found.data.privateItems.reduce((sum, p) => sum + p.notes, 0),
                    found.data.privateItems.reduce((sum, p) => sum + p.todos, 0),
                  ),
                  authors: found.data.privateItems.length,
                })}
              </p>
              {found.data.privateItems.map((p) => (
                <p key={p.authorUserId} className="text-xs text-muted-foreground">
                  {t('privateAuthor', { name: nameOf(p.authorUserId), items: items(p.notes, p.todos) })}
                </p>
              ))}
              <p className="pt-1 text-xs text-muted-foreground">{t('privateHint')}</p>
            </div>
          )}
          {found.data.truncated && <p className="mb-2 text-sm text-warning">{t('truncated')}</p>}
          {found.data.matches.length > 0 && (
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
          )}
        </>
      )}
    </>
  );
}
