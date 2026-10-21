// "Giờ đẹp" next to a channel's time picker (#980): up to three upcoming times from the channel's best slots, from the
// same metrics summary the Metrics tab reads. A click sets the picker; with too little history the button says why.
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { orpc, queryClient } from '../lib/api.ts';
import { BEST_TIME_DAYS, BEST_TIME_MIN_POSTS, channelBestTimes, knownZone, listedPosts, suggestBestTimes, takenTimes } from '../lib/social-best-time.ts';

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function BestTimeButton({ connectionId, timeZone, exceptVariantId, onPick, disabled = false }: { connectionId: string; timeZone: string | null | undefined; exceptVariantId?: string; onPick: (iso: string) => void; disabled?: boolean }) {
  const t = useTranslations('social.bestTime');
  const f = useFormat();
  const id = useId();
  const [open, setOpen] = useState(false);
  // The org's published channels over the window, latest metrics each; shared with the other buttons on the page.
  const history = useQuery({ ...orpc.social.metrics.summary.queryOptions({ input: { days: BEST_TIME_DAYS } }), staleTime: 10 * 60_000 });
  // The post's time zone: a slot is a weekday and hour there, whatever the viewer's clock says.
  const zone = knownZone(timeZone, browserZone());
  const best = useMemo(() => (history.data ? channelBestTimes(history.data, connectionId, zone) : null), [history.data, connectionId, zone]);
  const reason = history.error ? t('error') : best?.state === 'few' ? t('few', { min: String(BEST_TIME_MIN_POSTS) }) : best?.state === 'none' ? t('none') : null;
  // Read when the list opens: the clock and the other posts of the channel the screens already loaded (no request).
  const suggestions =
    open && best?.state === 'ready'
      ? suggestBestTimes(best.slots, {
          timeZone: zone,
          nowMs: Date.now(),
          taken: takenTimes(listedPosts(queryClient.getQueriesData({ queryKey: orpc.social.posts.list.key() }).map(([, data]) => data)), connectionId, exceptVariantId),
        })
      : [];
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {/* A disabled button takes no pointer events, so the reason sits on its wrapper. */}
      <span title={reason ?? t('hint', { days: String(BEST_TIME_DAYS), zone })}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || reason !== null || best === null}
          aria-expanded={open}
          aria-describedby={reason ? `${id}-why` : undefined}
          onClick={() => setOpen(!open)}
        >
          {t('action')}
        </Button>
      </span>
      {reason && (
        <span id={`${id}-why`} className="sr-only">
          {reason}
        </span>
      )}
      {open && (
        <span role="group" aria-label={t('choose')} className="inline-flex flex-wrap items-center gap-1.5">
          {suggestions.length === 0 ? (
            <span className="text-xs text-subtle-foreground">{t('allTaken')}</span>
          ) : (
            suggestions.map((s) => {
              const at = new Date(s.at).toISOString();
              return (
                <Button
                  key={s.at}
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  title={t('slotHint', { engagement: f.number(Math.round(s.engagement)), posts: String(s.posts) })}
                  onClick={() => {
                    onPick(at);
                    setOpen(false);
                  }}
                >
                  {f.weekdayShort(at)} {f.dateTime(at)}
                </Button>
              );
            })
          )}
        </span>
      )}
    </span>
  );
}
