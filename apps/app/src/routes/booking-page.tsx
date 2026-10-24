// The public booking page (#1318): /-/b/<org>/<event type>, no account. A visitor sees the type's free slots for a week
// in their own time zone, picks one, leaves a name and an email, and the page follows the request until the worker
// confirms it or says the time was just taken. The request token stays in memory and goes to the API in a POST body.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { zonedDate, type BookingPage as Page, type BookingStatus } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage } from '../lib/api.ts';
import { dayLabel, slotsByDay, timeIn, visitorTimeZone, weekRange, type Slot } from '../lib/booking.ts';
import { apiErrorFromResponse } from '../lib/errors.ts';

// How long the page follows a request before it says the answer is late.
const POLL_MS = 1000;
const POLL_FOR_MS = 60_000;

async function call<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(path, { credentials: 'omit', referrerPolicy: 'no-referrer', ...init });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json()) as T;
}
const post = <T,>(path: string, body: unknown) => call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function Followed({ path, token, when, onAgain }: { path: string; token: string; when: string; onAgain: () => void }) {
  const t = useTranslations('booking');
  const [since] = useState(() => Date.now());
  const status = useQuery({
    queryKey: ['booking-status', path, token],
    queryFn: () => post<BookingStatus>(path, { token }),
    refetchInterval: (q) => (q.state.data?.status === 'pending' && Date.now() - since < POLL_FOR_MS ? POLL_MS : false),
  });
  const s = status.data;
  if (status.error) return <ErrorText>{errorMessage(status.error)}</ErrorText>;
  if (!s || s.status === 'pending') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        {Date.now() - since < POLL_FOR_MS ? t('waiting') : t('late')}
      </p>
    );
  }
  if (s.status === 'confirmed') {
    return (
      <div className="space-y-1" role="status">
        <p className="font-medium text-foreground">{t('confirmed')}</p>
        <p className="text-sm text-muted-foreground">{t('confirmedAt', { when })}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2" role="alert">
      <p className="text-sm text-foreground">{s.refusal === 'taken' ? t('taken') : t('unavailable')}</p>
      <Button type="button" variant="outline" size="sm" onClick={onAgain}>
        {t('pickAnother')}
      </Button>
    </div>
  );
}

export function BookingPage({ org, type }: { org: string; type: string }) {
  const t = useTranslations('booking');
  const { locale } = useLocaleSetting();
  const [zone] = useState(visitorTimeZone);
  const [week, setWeek] = useState(0);
  const [now] = useState(() => Date.now());
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', note: '' });
  const [token, setToken] = useState<string | null>(null);
  const path = `/api/booking/${encodeURIComponent(org)}/${encodeURIComponent(type)}`;
  const range = weekRange(now, week);
  const page = useQuery({
    queryKey: ['booking-page', path, range.from],
    queryFn: () => call<Page>(`${path}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
  });
  const request = useMutation({
    mutationFn: (body: unknown) => post<{ token: string }>(path, body),
    onSuccess: (r) => setToken(r?.token ?? null),
  });
  useEffect(() => {
    document.title = page.data ? `${page.data.eventType.title} · ${page.data.orgName}` : t('title');
  }, [page.data, t]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!slot) return;
    request.mutate({ startsAt: slot.start, name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() || null, note: form.note.trim() || null, timeZone: zone });
  };
  const again = () => {
    setToken(null);
    setSlot(null);
    request.reset();
    void page.refetch();
  };

  if (page.isLoading) return <Spinner />;
  if (page.error) return <ErrorText>{errorMessage(page.error)}</ErrorText>;
  if (!page.data) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <Logo />
        <p className="mt-6 text-sm text-muted-foreground">{t('notFound')}</p>
      </main>
    );
  }
  const { eventType, orgName } = page.data;
  const days = slotsByDay(page.data.slots, zone);
  // "Thứ Hai, 02/11/2026, 09:00 - 09:30 (Asia/Ho_Chi_Minh)" in the visitor's zone.
  const chosen = (s: Slot) => `${dayLabel(zonedDate(zone, Date.parse(s.start)), locale)}, ${timeIn(s.start, zone, locale)} - ${timeIn(s.end, zone, locale)} (${zone})`;
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
      <header>
        <p className="text-sm text-muted-foreground">{orgName}</p>
        <h1 className="text-xl font-semibold text-foreground">{eventType.title}</h1>
        <p className="text-sm text-muted-foreground">
          {t('minutes', { count: String(eventType.durationMin) })} · {t(`locations.${eventType.locationKind}`)}
        </p>
        {eventType.description && <p className="mt-2 whitespace-pre-line text-sm text-foreground">{eventType.description}</p>}
      </header>
      <Card className="block p-4">
        {token && slot ? (
          <Followed path={path} token={token} when={chosen(slot)} onAgain={again} />
        ) : slot ? (
          <form className="space-y-3" onSubmit={submit} aria-label={t('formTitle')}>
            <p className="text-sm text-foreground">
              {t('chosen', { when: chosen(slot) })}
            </p>
            <div className="space-y-1">
              <Label htmlFor="booking-name">{t('name')}</Label>
              <Input id="booking-name" required maxLength={100} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="booking-email">{t('email')}</Label>
              <Input id="booking-email" required type="email" maxLength={254} autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="booking-phone">{t('phone')}</Label>
              <Input id="booking-phone" type="tel" maxLength={30} autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="booking-note">{t('note')}</Label>
              <Textarea id="booking-note" rows={3} maxLength={1000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={request.isPending || !form.name.trim() || !form.email.trim()}>
                {request.isPending ? <Spinner className="text-current" /> : null}
                {t('book')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSlot(null)}>
                {t('back')}
              </Button>
            </div>
            {request.error && <ErrorText>{errorMessage(request.error)}</ErrorText>}
          </form>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">{t('zone', { zone })}</p>
              <div className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" disabled={week === 0} onClick={() => setWeek((w) => w - 1)}>
                  {t('previousWeek')}
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={week >= 8} onClick={() => setWeek((w) => w + 1)}>
                  {t('nextWeek')}
                </Button>
              </div>
            </div>
            {days.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noSlots')}</p>
            ) : (
              <ul className="space-y-3">
                {days.map((d) => (
                  <li key={d.date}>
                    <p className="text-sm font-medium text-foreground">{dayLabel(d.date, locale)}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {d.slots.map((s) => (
                        <Button key={s.start} type="button" variant="outline" size="sm" onClick={() => setSlot(s)}>
                          {timeIn(s.start, zone, locale)}
                        </Button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    </main>
  );
}
