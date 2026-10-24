// The sections of a client report (#1259), in the report link and report schedule forms of the Metrics tab: a box per
// block of the page with arrows to move it, a box per extra that goes along with the numbers, and how many best posts.
// What is left unticked is not returned by the server at all, so the client never gets it.
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { REPORT_EXTRAS, hasBlock, moveBlock, type ReportSection, type SectionsDraft } from '../lib/social-report.ts';

export function ReportSectionsPicker({ id, value, onChange }: { id: string; value: SectionsDraft; onChange: (next: SectionsDraft) => void }) {
  const t = useTranslations('social.reportSections');
  const toggle = (section: ReportSection, on: boolean) => {
    const next = new Set(value.on);
    if (on) next.add(section);
    else next.delete(section);
    onChange({ ...value, on: next });
  };
  // The extras alone show nothing: at least one block.
  const none = !hasBlock(value);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-foreground">{t('title')}</legend>
      <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      <ol className="space-y-1">
        {value.order.map((b, i) => (
          <li key={b} className="flex items-center gap-2 text-sm text-muted-foreground">
            <label className="flex flex-1 items-center gap-2">
              <Checkbox checked={value.on.has(b)} onCheckedChange={(v) => toggle(b, v === true)} />
              {t(`block.${b}`)}
            </label>
            <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={t('up', { name: t(`block.${b}`) })} disabled={i === 0} onClick={() => onChange({ ...value, order: moveBlock(value.order, b, -1) })}>
              ↑
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              aria-label={t('down', { name: t(`block.${b}`) })}
              disabled={i === value.order.length - 1}
              onClick={() => onChange({ ...value, order: moveBlock(value.order, b, 1) })}
            >
              ↓
            </Button>
          </li>
        ))}
      </ol>
      {value.on.has('top') && (
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-top`} className="text-sm font-normal text-muted-foreground">
            {t('topCount')}
          </Label>
          <Input
            id={`${id}-top`}
            type="number"
            min={3}
            max={20}
            className="h-8 w-20"
            value={String(value.topCount)}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) onChange({ ...value, topCount: Math.min(20, Math.max(3, n)) });
            }}
          />
        </div>
      )}
      <p className="text-xs font-medium text-muted-foreground">{t('extrasTitle')}</p>
      <div className="grid gap-1 sm:grid-cols-2">
        {REPORT_EXTRAS.map((e) => (
          <label key={e} className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={value.on.has(e)} onCheckedChange={(v) => toggle(e, v === true)} />
            {t(`extra.${e}`)}
          </label>
        ))}
      </div>
      {none && <p className="text-xs text-warning">{t('none')}</p>}
    </fieldset>
  );
}
