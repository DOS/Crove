// An emoji picker for the composer (#634): the emoji Vietnamese shops and agencies use most in posts, put in the text at
// the cursor. The character counters see them as the platform counts them, since they read the text itself.
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { insertText } from '../lib/social-draft.ts';

export const EMOJI = [
  '🔥', '✨', '🎉', '🎊', '🎁', '💥', '⚡', '🚀', '💯', '⭐', '🌟', '🏆',
  '✅', '❌', '⚠️', '📣', '📢', '🆕', '🔝', '💡', '📍', '📞', '⏰', '🗓️',
  '👉', '👇', '👆', '👍', '👏', '🙏', '🤝', '💪', '👀', '❤️', '💖', '😍',
  '🥰', '😊', '😂', '🤩', '😎', '😘', '🛒', '🛍️', '💰', '💸', '🏷️', '📦',
  '☕', '🍜', '🍲', '🥢', '🎂', '🌸', '🌿', '🍀', '☀️', '🌙', '🇻🇳', '📸',
] as const;

export function EmojiPicker({ targetId, value, onChange, disabled }: { targetId: string; value: string; onChange: (text: string) => void; disabled?: boolean }) {
  const t = useTranslations('social');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (disabled) return null;
  const pick = (emoji: string) => {
    const el = document.getElementById(targetId) as HTMLTextAreaElement | null;
    const next = insertText(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, emoji);
    onChange(next.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.cursor, next.cursor);
    });
  };
  return (
    <div ref={box} className="relative inline-block">
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2" aria-label={t('emoji')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        😊
      </Button>
      {open && (
        <div role="listbox" aria-label={t('emoji')} className="absolute left-0 z-20 mt-1 grid w-72 grid-cols-8 gap-1 rounded-lg border bg-popover p-2 shadow-md">
          {EMOJI.map((e) => (
            <button key={e} type="button" role="option" aria-selected={false} className="rounded p-1 text-lg hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none" onClick={() => pick(e)}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
