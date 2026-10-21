import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { localToday } from '../lib/reversal.ts';

// Asks for the year-end closing (#889), kết chuyển: the kernel builds the entry from the ledger (classes 5 to 8 to 911,
// the result to 4212, dated 31/12) as a general journal voucher that an owner or admin approves in the Inbox (R3,
// four-eyes, fresh MFA). The year must have ended; the last one is offered first.
export function YearClosingFormCard({ slug, onClose }: { slug: string; onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('yearClosing');
  const lastYear = Number(localToday().slice(0, 4)) - 1;
  const years = Array.from({ length: 5 }, (_, i) => lastYear - i);
  const [year, setYear] = useState(lastYear);
  // One key per form: a retry of the same request returns the same proposal.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const request = useMutation(orpc.inbox.request.mutationOptions({ onSettled: () => void queryClient.invalidateQueries() }));

  if (request.data) {
    return (
      <Alert className="mb-6">
        <AlertDescription>
          {t('created', { year: String(year) })}{' '}
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
        aria-label={t('title')}
        onSubmit={(event) => {
          event.preventDefault();
          request.mutate({ command: 'finance.closing.record', idempotencyKey, input: { year } });
        }}
      >
        <div>
          <h2 className="text-sm font-semibold">{t('title')}</h2>
          <p className="mt-1 text-xs text-subtle-foreground">{t('intro')}</p>
        </div>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('year')}</span>
          <NativeSelect className="mt-1 w-32" value={String(year)} onChange={(e) => setYear(Number(e.target.value))} disabled={request.isPending}>
            {years.map((y) => (
              <NativeSelectOption key={y} value={String(y)}>
                {y}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {request.error && <ErrorText>{errorMessage(request.error)}</ErrorText>}
        <div className="flex gap-2">
          <Button type="submit" disabled={request.isPending}>
            {request.isPending ? <Spinner className="text-current" /> : null}
            {t('submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={request.isPending}>
            {root('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
