// Bold and italic text in the composer (#1179), as Planable's and Publer's buttons make it: Facebook, LinkedIn, X and
// Threads have no rich text, so the selection is written with Unicode's styled letters (styleSelection, shared with the
// banned-word and duplicate checks, which read them as plain letters). Links, hashtags, @mentions and emoji in the
// selection are left as they are. The hints say what the letters cost: screen readers read them badly, X counts each
// as 2, and WordPress, Zalo OA articles and Google Business show them as they are rather than as their own formatting.
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { hasStyledText, styleSelection, type TextStyle } from '@crove/mod-social/contract';

// The style buttons, in order; Bỏ định dạng follows them.
const STYLES: ReadonlyArray<{ style: TextStyle; glyph: string; className: string }> = [
  { style: 'bold', glyph: 'B', className: 'font-bold' },
  { style: 'italic', glyph: 'I', className: 'italic' },
  { style: 'boldItalic', glyph: 'BI', className: 'font-bold italic' },
];
// The channels that show the letters as they are, where the channel has its own formatting or plain text.
const AS_IS: ReadonlySet<string> = new Set(['wordpress', 'zalo_oa', 'google_business']);

export function TextStyleButtons({ targetId, value, onChange, disabled }: { targetId: string; value: string; onChange: (text: string) => void; disabled?: boolean }) {
  const t = useTranslations('social.textStyle');
  const [pickFirst, setPickFirst] = useState(false);
  // The ask to select some text first goes away by itself, as a hint should.
  useEffect(() => {
    if (!pickFirst) return;
    const timer = setTimeout(() => setPickFirst(false), 4000);
    return () => clearTimeout(timer);
  }, [pickFirst]);
  if (disabled) return null;
  const apply = (style: TextStyle | null) => {
    const el = document.getElementById(targetId) as HTMLTextAreaElement | null;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === end) {
      setPickFirst(true);
      el.focus();
      return;
    }
    setPickFirst(false);
    const next = styleSelection(value, start, end, style);
    if (next.text !== value) onChange(next.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  };
  return (
    <div role="group" aria-label={t('toolbar')} className="inline-flex flex-wrap items-center gap-1">
      {STYLES.map(({ style, glyph, className }) => (
        // The glyph is for the eye and the style's name for the ear: an aria-label would hide the glyph a voice user
        // reads off the button (WCAG 2.5.3, #1572).
        <Button key={style} type="button" variant="ghost" size="sm" className={`h-7 px-2 ${className}`} title={t(style)} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(style)}>
          <span aria-hidden="true">{glyph}</span>
          <span className="sr-only">{t(style)}</span>
        </Button>
      ))}
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2" title={t('plainHint')} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(null)}>
        {t('plain')}
      </Button>
      <span aria-live="polite" className="text-xs text-subtle-foreground">
        {pickFirst ? t('pickFirst') : ''}
      </span>
    </div>
  );
}

/** What styled letters cost, shown while the text holds some: for the channels given (the post's, or the one whose own text it is). */
export function TextStyleHint({ text, providers }: { text: string; providers: readonly string[] }) {
  const t = useTranslations('social.textStyle');
  if (!hasStyledText(text)) return null;
  return (
    <div className="space-y-0.5 text-xs text-subtle-foreground">
      <p>{t('hint')}</p>
      {providers.includes('x') && <p>{t('hintX')}</p>}
      {providers.some((p) => AS_IS.has(p)) && <p>{t('hintAsIs')}</p>}
    </div>
  );
}
