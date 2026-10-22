// Posts a channel published outside Crove (#1054): the Metrics tab's switch that counts them, the chip each carries,
// and its line in the published posts table (a link to the post on the platform, not to a Crove post).
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Checkbox } from '@crove/ui/components/checkbox';
import { cn } from '@crove/ui/lib/utils';
import { outsideUrl } from '../lib/social-external.ts';

// label: the chip's text where the page must not name Crove (a client report, which may carry the agency's brand).
export function OutsideChip({ label, className }: { label?: string; className?: string }) {
  const t = useTranslations('social.external');
  return (
    <Badge variant="outline" className={cn('shrink-0', className)}>
      {label ?? t('chip')}
    </Badge>
  );
}

// disabled: a label filter is on, and outside posts carry no label.
export function OutsideSwitch({ checked, onChange, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  const t = useTranslations('social.external');
  return (
    <div className="space-y-0.5">
      <label className={cn('flex items-center gap-2 text-sm text-foreground', disabled && 'text-subtle-foreground')}>
        <Checkbox checked={checked && !disabled} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
        {t('switch')}
      </label>
      <p className="text-xs text-subtle-foreground">{disabled ? t('noLabels') : t('hint')}</p>
    </div>
  );
}

// The post cell of an outside post: its excerpt, linked to the post's page when it has an https one, and the chip.
export function OutsidePostCell({ excerpt, url, meta }: { excerpt: string; url: string | null; meta: string }) {
  const t = useTranslations('social.external');
  const href = outsideUrl(url);
  const text = excerpt || t('noText');
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="line-clamp-1 text-foreground hover:underline">
            {text}
          </a>
        ) : (
          <span className="line-clamp-1 text-foreground">{text}</span>
        )}
        <OutsideChip />
      </span>
      <p className="text-xs text-subtle-foreground">{meta}</p>
    </>
  );
}
