// Notes on calendar dates (#794): a team's own marks, such as a launch, a sale or a client event, shown on each day
// they cover next to the built-in occasions. Owners, admins and members add, change and remove them here.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { cn } from '@crove/ui/lib/utils';
import { DateInput } from './date-input.tsx';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { LABEL_COLORS, LABEL_SWATCH, LABEL_TONE, type LabelColor } from '../lib/social-labels.ts';

export type CalendarNote = Awaited<ReturnType<typeof client.social.calendarNotes.list>>[number];
// What the editor opens with: a note to change, or the day a new one starts on.
export type NoteDraft = { note: CalendarNote } | { day: string };

export function NoteChip({ note, onOpen }: { note: CalendarNote; onOpen: ((note: CalendarNote) => void) | null }) {
  const className = cn('block w-full truncate rounded-md border px-1.5 py-0.5 text-left text-xs font-medium', LABEL_TONE[note.color]);
  if (!onOpen) {
    return (
      <span className={className} title={note.title}>
        {note.title}
      </span>
    );
  }
  return (
    <button type="button" className={cn(className, 'hover:ring-1 hover:ring-ring/60')} title={note.title} onClick={() => onOpen(note)}>
      {note.title}
    </button>
  );
}

export function NoteEditor({ draft, onClose }: { draft: NoteDraft; onClose: () => void }) {
  const t = useTranslations('social.calendarNotes');
  const colors = useTranslations('social.labels');
  const existing = 'note' in draft ? draft.note : null;
  const [title, setTitle] = useState(existing?.title ?? '');
  const [startsOn, setStartsOn] = useState(existing?.startsOn ?? ('day' in draft ? draft.day : ''));
  const [endsOn, setEndsOn] = useState(existing?.endsOn ?? ('day' in draft ? draft.day : ''));
  const [color, setColor] = useState<LabelColor>(existing?.color ?? 'blue');
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.social.calendarNotes.list.key() });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => client.social.calendarNotes.save({ ...(existing ? { noteId: existing.id } : {}), title: title.trim(), startsOn, endsOn: endsOn < startsOn ? startsOn : endsOn, color }),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => client.social.calendarNotes.remove({ noteId: existing?.id as string }), onSuccess: done });
  return (
    <Card className="block space-y-3 p-4">
      <h3 className="text-sm font-medium text-foreground">{existing ? t('edit') : t('add')}</h3>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() && startsOn && !save.isPending) save.mutate();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="note-title" className="text-xs">
            {t('title')}
          </Label>
          <Input id="note-title" value={title} maxLength={120} placeholder={t('titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="note-from" className="text-xs">
            {t('from')}
          </Label>
          <DateInput id="note-from" value={startsOn} onChange={setStartsOn} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="note-to" className="text-xs">
            {t('to')}
          </Label>
          <DateInput id="note-to" value={endsOn} min={startsOn} onChange={setEndsOn} className="w-40" />
        </div>
        <div className="flex flex-wrap items-center gap-1 sm:col-span-3" role="radiogroup" aria-label={t('color')}>
          {LABEL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={colors(`colors.${c}`)}
              title={colors(`colors.${c}`)}
              onClick={() => setColor(c)}
              className={cn('size-6 rounded-full border-2', LABEL_SWATCH[c], color === c ? 'border-foreground' : 'border-transparent')}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={!title.trim() || !startsOn || save.isPending}>
            {t('save')}
          </Button>
          {existing && (
            <Button type="button" size="sm" variant="outline" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {t('remove')}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </form>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </Card>
  );
}
