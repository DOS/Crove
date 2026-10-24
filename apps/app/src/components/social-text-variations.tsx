// Text variations (#1260) on the screen of an evergreen or series post: up to 5 other texts, each evergreen repost or
// recurring copy taking the next one in turn, and the one that goes next marked. A person writes them here, or asks AI
// (*Viết thêm biến thể*, the rewrite's "variation" action, through its checks: role, AI configured, budget); an AI text
// only fills a new box, and is saved, marked as AI's, when the person saves the list.
import { useMutation } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { SOCIAL_TEXT_VARIATION_CHARS_MAX, SOCIAL_TEXT_VARIATIONS_MAX } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText, Spinner } from './ui.tsx';
import { client, errorMessage } from '../lib/api.ts';

interface Variation {
  text: string;
  ai: boolean;
}
// A box of the form; the key keeps a box's state when the list is reordered.
interface Row extends Variation {
  key: number;
}

// The most text the AI rewrite takes (social.posts.rewriteWithAi).
const AI_TEXT_MAX = 20_000;

export function TextVariationsCard({ post, onDone }: { post: { id: string; body: string; textVariations: Variation[]; textVariationNext: number }; onDone: () => void }) {
  const t = useTranslations('social.variations');
  const id = useId();
  const keys = useRef(0);
  const [rows, setRows] = useState<Row[]>(() => post.textVariations.map((v) => ({ ...v, key: keys.current++ })));
  const [aiSame, setAiSame] = useState(false);
  const saved = post.textVariations;
  // The saved text the next copy takes; a box showing it is marked.
  const nextText = saved[post.textVariationNext]?.text ?? null;
  const list = rows.map((r) => ({ text: r.text.trim(), ai: r.ai }));
  const dirty = JSON.stringify(list) !== JSON.stringify(saved);
  const blank = list.some((v) => v.text === '');
  const repeated = new Set(list.map((v) => v.text)).size !== list.length;
  const tooLong = list.some((v) => v.text.length > SOCIAL_TEXT_VARIATION_CHARS_MAX);
  const full = rows.length >= SOCIAL_TEXT_VARIATIONS_MAX;
  const source = post.body.trim();

  const save = useMutation({ mutationFn: () => client.social.posts.setTextVariations({ postId: post.id, variations: list }), onSuccess: onDone });
  const ai = useMutation({
    mutationFn: () => client.social.posts.rewriteWithAi({ text: source, title: null, action: 'variation' }),
    onSuccess: (result) => {
      const text = result.text.trim();
      // The same as the post or a variation already there would only be refused on save.
      const same = text === source || list.some((v) => v.text === text);
      setAiSame(same);
      if (!same) setRows((current) => (current.length >= SOCIAL_TEXT_VARIATIONS_MAX ? current : [...current, { text, ai: true, key: keys.current++ }]));
    },
  });
  const busy = save.isPending || ai.isPending;

  const update = (key: number, text: string) => setRows((current) => current.map((r) => (r.key === key ? { ...r, text } : r)));
  const remove = (key: number) => setRows((current) => current.filter((r) => r.key !== key));
  const move = (from: number, to: number) =>
    setRows((current) => {
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      const [row] = next.splice(from, 1);
      if (row) next.splice(to, 0, row);
      return next;
    });

  return (
    <Card className="block space-y-3 p-4">
      <p className="text-sm font-medium text-foreground">{t('title')}</p>
      <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">{t('empty')}</p>}
      <ol className="space-y-3">
        {rows.map((row, i) => (
          <li key={row.key} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`${id}-${row.key}`} className="text-xs">
                {t('label', { n: i + 1 })}
              </Label>
              {nextText !== null && row.text.trim() === nextText && <Badge variant="secondary">{t('next')}</Badge>}
              {row.ai && <Badge variant="outline">{t('ai')}</Badge>}
              <span className="ml-auto flex gap-1">
                <Button variant="ghost" size="sm" disabled={busy || i === 0} onClick={() => move(i, i - 1)} aria-label={t('moveUp')} title={t('moveUp')}>
                  ↑
                </Button>
                <Button variant="ghost" size="sm" disabled={busy || i === rows.length - 1} onClick={() => move(i, i + 1)} aria-label={t('moveDown')} title={t('moveDown')}>
                  ↓
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(row.key)} aria-label={t('remove')} title={t('remove')}>
                  ✕
                </Button>
              </span>
            </div>
            <Textarea id={`${id}-${row.key}`} rows={3} value={row.text} disabled={busy} onChange={(e) => update(row.key, e.target.value)} />
            <p className="text-xs text-subtle-foreground">{t('chars', { count: row.text.trim().length })}</p>
          </li>
        ))}
      </ol>
      {blank && <p className="text-xs text-destructive">{t('blank')}</p>}
      {repeated && <p className="text-xs text-destructive">{t('repeated')}</p>}
      {tooLong && <p className="text-xs text-destructive">{t('tooLong', { max: SOCIAL_TEXT_VARIATION_CHARS_MAX })}</p>}
      {full && <p className="text-xs text-muted-foreground">{t('full', { max: SOCIAL_TEXT_VARIATIONS_MAX })}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || full} onClick={() => setRows((current) => [...current, { text: '', ai: false, key: keys.current++ }])}>
          {t('add')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || full || source === '' || source.length > AI_TEXT_MAX}
          title={source === '' ? t('aiNoText') : undefined}
          onClick={() => {
            setAiSame(false);
            ai.mutate();
          }}
        >
          {ai.isPending ? <Spinner className="text-current" /> : null}
          {t('addAi')}
        </Button>
        <Button size="sm" disabled={busy || !dirty || blank || repeated || tooLong} onClick={() => save.mutate()}>
          {t('save')}
        </Button>
      </div>
      <p className="text-xs text-subtle-foreground">{t('aiHint')}</p>
      {dirty && <p className="text-xs text-muted-foreground">{t('unsaved')}</p>}
      {aiSame && <p className="text-xs text-muted-foreground">{t('aiSame')}</p>}
      {(save.error || ai.error) && <ErrorText>{errorMessage(save.error ?? ai.error)}</ErrorText>}
    </Card>
  );
}
