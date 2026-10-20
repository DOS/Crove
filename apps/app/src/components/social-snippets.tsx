// Saved snippets in the composer (#584): pick one to put it in the text at the cursor (or over a selection). A
// template into an empty text starts the post with it. The list is the org's snippets for any platform and, in a
// channel's editor, the ones for that platform.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { NativeSelect, NativeSelectOption, NativeSelectOptGroup } from '@crove/ui/components/native-select';
import { orpc } from '../lib/api.ts';
import { insertAt } from '../lib/social-snippets.ts';

export function SnippetPicker({ slug, targetId, value, onChange, provider, disabled }: { slug: string; targetId: string; value: string; onChange: (text: string) => void; provider?: string; disabled?: boolean }) {
  const t = useTranslations('social.snippets');
  const list = useQuery(orpc.social.snippets.list.queryOptions({ input: provider ? { provider } : {} }));
  // The shared text goes to every channel: only snippets for any platform are offered there.
  const snippets = (list.data ?? []).filter((s) => (provider ? true : s.provider === null));
  if (disabled) return null;
  const pick = (id: string) => {
    const s = snippets.find((x) => x.id === id);
    if (!s) return;
    const el = document.getElementById(targetId) as HTMLTextAreaElement | null;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = s.isTemplate && value.trim() === '' ? { text: s.body, cursor: s.body.length } : insertAt(value, start, end, s.body);
    onChange(next.text);
    // Back to the text, the cursor after what was put in, once React has rendered it.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.cursor, next.cursor);
    });
  };
  const templates = snippets.filter((s) => s.isTemplate);
  const pieces = snippets.filter((s) => !s.isTemplate);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {snippets.length > 0 && (
        <NativeSelect value="" aria-label={t('insert')} className="w-auto" size="sm" onChange={(e) => pick(e.target.value)}>
          <NativeSelectOption value="">{t('insert')}</NativeSelectOption>
          {pieces.length > 0 && (
            <NativeSelectOptGroup label={t('pieces')}>
              {pieces.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {s.name}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
          )}
          {templates.length > 0 && (
            <NativeSelectOptGroup label={t('templates')}>
              {templates.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {s.name}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
          )}
        </NativeSelect>
      )}
      <Link to="/o/$slug/social/snippets" params={{ slug }} className="text-link hover:underline">
        {snippets.length > 0 ? t('manage') : t('create')}
      </Link>
    </div>
  );
}
