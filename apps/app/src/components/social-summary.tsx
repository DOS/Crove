// An AI summary of the period (#1237): on the Metrics tab, a draft of the window shown (its days, label and outside
// posts) to read, edit and copy; nothing is saved. The client report form writes one into its note the same way
// (social-report-links.tsx), saved only with the link. The server writes it from the period's own figures and refuses
// a summary that cites any other number.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { getConfig } from '../lib/auth.ts';
import { client, errorMessage, orpc } from '../lib/api.ts';

// The zone the period's dates are written in: the browser's, as the screens show dates.
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;

/** Whether the member may have AI write a summary here: members and above, on a server with AI. */
export function useCanSummarize(): boolean {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  return getConfig().aiEnabled === true && (role === 'owner' || role === 'admin' || role === 'member');
}

/** The language a summary is written in: the app's. */
export function useSummaryLanguage(): 'vi' | 'en' {
  return useLocale() === 'en' ? 'en' : 'vi';
}

export interface MetricsWindow {
  days: number;
  labelId: string | undefined;
  includeExternal: boolean;
}

/** The Metrics tab's summary of a window: write() asks for it, and the box shows it while open. */
export function useMetricsSummary() {
  const language = useSummaryLanguage();
  const [open, setOpen] = useState<MetricsWindow | null>(null);
  const [text, setText] = useState('');
  const write = useMutation({
    mutationFn: (w: MetricsWindow) => {
      const zone = browserTimeZone();
      return client.social.metrics.writeSummary({ days: w.days, ...(w.labelId ? { labelId: w.labelId } : w.includeExternal ? { includeExternal: true } : {}), ...(zone ? { timeZone: zone } : {}), language });
    },
    onSuccess: (r) => setText(r.text),
  });
  return {
    open,
    text,
    setText,
    write,
    start: (w: MetricsWindow) => {
      setOpen(w);
      setText('');
      write.mutate(w);
    },
    close: () => {
      setOpen(null);
      setText('');
      write.reset();
    },
  };
}

// The box of the Metrics tab's summary: the draft to edit and copy, written again on demand.
export function MetricsSummary({ summary }: { summary: ReturnType<typeof useMetricsSummary> }) {
  const t = useTranslations('social.summary');
  const [copied, setCopied] = useState(false);
  const { open, text, write } = summary;
  if (!open) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title', { days: open.days })}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {write.isPending && <p className="text-sm text-muted-foreground">{t('writing')}</p>}
      {write.error && <ErrorText>{errorMessage(write.error)}</ErrorText>}
      {text && !write.isPending && (
        <div className="space-y-1.5">
          <Label htmlFor="metrics-summary" className="sr-only">
            {t('label')}
          </Label>
          <Textarea
            id="metrics-summary"
            value={text}
            rows={6}
            maxLength={2000}
            onChange={(e) => {
              summary.setText(e.target.value);
              setCopied(false);
            }}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {text && !write.isPending && (
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? t('copied') : t('copy')}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={write.isPending}
          onClick={() => {
            setCopied(false);
            write.mutate(open);
          }}
        >
          {t('again')}
        </Button>
        <Button size="sm" variant="ghost" onClick={summary.close}>
          {t('close')}
        </Button>
      </div>
    </Card>
  );
}
