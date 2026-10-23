// Engagement rate (#1157) as the screens write it: a percentage in the app's number format ("3,45%" in Vietnamese),
// "theo lượt hiển thị" under it when it is over impressions because nothing counted reports reach, and "-" without
// either. The rate itself comes from the Social contract (engagementRateOf), the same on every screen and in the export.
import { useTranslations } from 'use-intl';
import { engagementRate, engagementRatePercent, type EngagementRate } from '@crove/mod-social/contract';
import { cn } from '@crove/ui/lib/utils';
import { useFormat } from '../i18n/provider.tsx';

/** "3,45%" (vi) or "3.45%" (en) for a rate, "-" for none. */
export function useRateText(): (rate: Pick<EngagementRate, 'rate'> | null | undefined) => string {
  const f = useFormat();
  return (rate) => (rate && Number.isFinite(rate.rate) ? `${f.number(engagementRatePercent(rate))}%` : '-');
}

/** The rate, with what it is over when that is impressions. */
export function RateValue({ rate, className }: { rate: EngagementRate | null | undefined; className?: string }) {
  const t = useTranslations('social.engagementRate');
  const text = useRateText();
  return (
    <>
      <span className={cn('block', className)}>{text(rate)}</span>
      {rate?.basis === 'impressions' && <span className="block text-xs font-normal text-subtle-foreground">{t('byImpressions')}</span>}
    </>
  );
}

/**
 * The rate in words, with "theo lượt hiển thị" when over impressions: "Tỷ lệ tương tác: 3,45%" for a line of counts
 * (line), "tỷ lệ tương tác 3,45%" inside a sentence (inline).
 */
export function useRatePhrase(kind: 'line' | 'inline'): (rate: EngagementRate | null | undefined) => string {
  const t = useTranslations('social.engagementRate');
  const text = useRateText();
  return (rate) => {
    const value = t(kind, { rate: text(rate) });
    return rate?.basis === 'impressions' ? `${value} ${t('byImpressions')}` : value;
  };
}

/** A post's rate as an item of the post page's counts list (a <dl>): "-" when it reports neither reach nor impressions. */
export function EngagementRateItem({ metrics }: { metrics: Readonly<Record<string, number>> }) {
  const t = useTranslations('social.engagementRate');
  const text = useRateText();
  const rate = engagementRate(metrics);
  return (
    <div className="flex gap-1">
      <dt title={t('hint')}>{t('label')}</dt>
      <dd className="font-medium text-foreground tabular-nums">
        {text(rate)}
        {rate?.basis === 'impressions' && <span className="font-normal text-subtle-foreground"> {t('byImpressions')}</span>}
      </dd>
    </div>
  );
}
