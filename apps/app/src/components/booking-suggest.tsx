// Times to offer a client (#1440), on the "Lịch hẹn" screen: the member picks an event type and may paste what the
// client wrote (a mail, a Zalo or chat line). The server's model, when it has one, reads which days and times the client
// asks for; the slots are real free slots of the type inside them, else the next free ones. The member copies the
// draft reply and sends it themselves: nothing is sent or saved here.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { zonedInstant, type BookingSuggestion } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText, Spinner } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { dayLabel, timeIn } from '../lib/booking.ts';
import { whenOf } from '../routes/booking-page.tsx';

export const bookingLinkOf = (origin: string, org: string, type: string) => `${origin}/-/b/${encodeURIComponent(org)}/${encodeURIComponent(type)}`;

export function BookingSuggestCard({ slug }: { slug: string }) {
  const t = useTranslations('bookings.suggest');
  const { locale } = useLocaleSetting();
  const [open, setOpen] = useState(false);
  const types = useQuery({ ...orpc.crm.eventTypes.list.queryOptions(), enabled: open });
  const active = (types.data ?? []).filter((e) => e.active);
  const [typeId, setTypeId] = useState('');
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('');
  const [copied, setCopied] = useState(false);
  const chosen = typeId || active[0]?.id || '';
  const suggest = useMutation(
    orpc.crm.bookings.suggest.mutationOptions({
      onSuccess: (s) => {
        setReply(draftOf(s));
        setCopied(false);
      },
    }),
  );
  const result = suggest.data;

  function draftOf(s: BookingSuggestion): string {
    const link = bookingLinkOf(window.location.origin, slug, s.eventType.slug);
    if (s.slots.length === 0) return t('replyNone', { title: s.eventType.title, link });
    const lines = s.slots.map((x) => `- ${whenOf(x, s.timeZone, locale)}`).join('\n');
    return t('reply', { title: s.eventType.title, slots: lines, link });
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reply);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (!open) {
    return (
      <div className="mb-4">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {t('open')}
        </Button>
      </div>
    );
  }
  return (
    <Card className="mb-4 block space-y-3 p-4" data-testid="booking-suggest">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {types.error && <ErrorText>{errorMessage(types.error)}</ErrorText>}
      {types.isSuccess && active.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noTypes')}</p>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (chosen) suggest.mutate({ eventTypeId: chosen, message: message.trim() });
          }}
        >
          <NativeSelect className="w-full" value={chosen} aria-label={t('type')} onChange={(e) => setTypeId(e.target.value)}>
            {active.map((e) => (
              <NativeSelectOption key={e.id} value={e.id}>
                {e.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Textarea rows={3} maxLength={4000} placeholder={t('messagePlaceholder')} aria-label={t('message')} value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={!chosen || suggest.isPending}>
              {suggest.isPending ? <Spinner className="text-current" /> : null}
              {t('submit')}
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('close')}
            </Button>
          </div>
        </form>
      )}
      {suggest.error && <ErrorText>{errorMessage(suggest.error)}</ErrorText>}
      {result && (
        <div className="space-y-2 rounded-lg border border-border p-3" data-testid="booking-suggestion">
          <p className="text-xs text-muted-foreground">
            {result.ai === 'used' && result.windows.length > 0
              ? t('aiRead', {
                  windows: result.windows
                    .map((w) => `${dayLabel(w.date, locale)} ${timeIn(new Date(zonedInstant(result.timeZone, w.date, w.from)).toISOString(), result.timeZone, locale)} - ${timeIn(new Date(zonedInstant(result.timeZone, w.date, w.to)).toISOString(), result.timeZone, locale)}`)
                    .join('; '),
                })
              : t(`ai.${result.ai === 'used' ? 'noWindows' : result.ai}`)}
          </p>
          {result.ai === 'used' && result.windows.length > 0 && !result.inWindows && <p className="text-xs text-muted-foreground">{t('outside')}</p>}
          <Textarea rows={7} aria-label={t('replyLabel')} value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              {copied ? t('copied') : t('copy')}
            </Button>
            <p className="text-xs text-subtle-foreground">{t('sendYourself')}</p>
          </div>
        </div>
      )}
    </Card>
  );
}
