import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Table, TableBody, TableCell, TableRow } from '@crove/ui/components/table';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { apiFetch, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { useFormat } from '../i18n/provider.tsx';
import { MAX_REASON_LENGTH, canAskReversal, defaultReversalDate, reversalErrorMessage, reversalFormError } from '../lib/reversal.ts';

interface Entry {
  id: string;
  entryDate: string;
  document?: { series: string; number: string; partyName: string } | undefined;
}

// Asks for a reversal (#165): a proposal that an owner or admin approves like any posting (R3, four-eyes, fresh MFA).
function ReversalForm({ entry, slug, onClose }: { entry: Entry; slug: string; onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('reversal');
  const f = useFormat();
  const [entryDate, setEntryDate] = useState(() => defaultReversalDate(entry.entryDate));
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  // One key per form: a retry of the same request returns the same proposal.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const request = useMutation(orpc.inbox.request.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));
  const problem = reversalFormError({ entryDate, reason }, entry.entryDate, root, f.date);

  if (request.data) {
    return (
      <Alert className="mt-3">
        <AlertDescription>
          {t('created')}{' '}
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: request.data.proposalId }} className="text-link underline">
            {t('viewProposal')}
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form
      className="mt-3 space-y-3 rounded-lg border bg-muted/40 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (problem) return;
        request.mutate({ command: 'finance.journal.reverse', input: { entryId: entry.id, entryDate, reason: reason.trim() }, idempotencyKey });
      }}
    >
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {entry.document && (
        <p className="text-sm text-warning">
          {t('documentNote', {
            document: `${entry.document.series ? `${entry.document.series}-` : ''}${entry.document.number}`,
            vendor: entry.document.partyName,
          })}
        </p>
      )}
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('date')}</span>
        <Input type="date" required min={entry.entryDate} value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className="mt-1 w-44" />
      </label>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('reason')}</span>
        <Input
          required
          maxLength={MAX_REASON_LENGTH}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1"
          placeholder={t('reasonPlaceholder')}
        />
      </label>
      {touched && problem && <ErrorText>{problem}</ErrorText>}
      {request.error && <ErrorText>{reversalErrorMessage(request.error, root)}</ErrorText>}
      <div className="flex gap-2">
        <Button type="submit" disabled={request.isPending}>
          {request.isPending ? <Spinner /> : null}
          {t('submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose} disabled={request.isPending}>
          {root('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

export function JournalPage() {
  const t = useTranslations('journal');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reversing, setReversing] = useState<string | null>(null);
  const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const journal = useQuery(orpc.journal.list.queryOptions({ input: range }));
  const org = useQuery(orpc.org.get.queryOptions());

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
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('from')}</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-44" />
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('to')}</span>
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
              <div id={`entry-${entry.id}`} className="flex scroll-mt-4 flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-foreground">{entry.description}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {entry.reverses && <Badge variant="secondary">{t('reversalBadge')}</Badge>}
                  {entry.reversedBy && <Badge variant="warning">{t('reversedBadge')}</Badge>}
                  {entry.document?.voided && <Badge variant="destructive">{t('documentVoided')}</Badge>}
                  <p className="text-xs text-subtle-foreground">{f.date(entry.entryDate)}</p>
                </div>
              </div>
              {/* The reversal link both ways (#138); it scrolls to the other entry when it is in the range shown. */}
              {(entry.reverses || entry.reversedBy) && (
                <p className="mt-1 text-xs">
                  {entry.reverses && (
                    <a href={`#entry-${entry.reverses.id}`} className="text-link hover:underline">
                      {t('reversesLink', { date: f.date(entry.reverses.entryDate) })}
                    </a>
                  )}
                  {entry.reversedBy && (
                    <a href={`#entry-${entry.reversedBy.id}`} className="text-link hover:underline">
                      {t('reversedByLink', { date: f.date(entry.reversedBy.entryDate) })}
                    </a>
                  )}
                </p>
              )}
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
              {canAskReversal(entry, org.data?.role) &&
                (reversing === entry.id ? (
                  <ReversalForm entry={entry} slug={slug} onClose={() => setReversing(null)} />
                ) : (
                  <div className="mt-2 flex justify-end">
                    <Button variant="ghost" onClick={() => setReversing(entry.id)}>
                      {t('reverse')}
                    </Button>
                  </div>
                ))}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
