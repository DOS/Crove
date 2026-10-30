// The public booking page (#1318): /-/b/<org>/<event type>, no account. A visitor sees the type's free slots for a week
// in their own time zone, picks one, leaves a name and an email, and the page follows the request until the worker
// confirms it or says the time was just taken. The request token stays in memory and goes to the API in a POST body.
//
// The links in the booking's mails (#1319) open the same page with a manage token in the fragment (#m=<token>), which
// the browser never sends: the page reads the booking with it and lets the visitor cancel it or move it to another
// free slot, then follows the ask until the worker answers. A cancel or a move ends the link.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { zonedDate, type BookingManage, type BookingPage as Page, type BookingStatus } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Skeleton } from '@crove/ui/components/skeleton';
import { Textarea } from '@crove/ui/components/textarea';
import { CardSkeleton, ErrorText, FieldError, fieldControl, focusFirstInvalid, isEmailAddress, Logo, Spinner, useFieldErrors } from '../components/ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import type { Locale } from '../i18n/locale.ts';
import { getConfig } from '../lib/auth.ts';
import { errorMessage } from '../lib/api.ts';
import { dayLabel, manageTokenOf, slotsByDay, timeIn, visitorTimeZone, weekRange, type Slot } from '../lib/booking.ts';
import { apiErrorFromResponse } from '../lib/errors.ts';
import { loadTurnstile } from '../lib/turnstile.ts';

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

// "Thứ Hai, 02/11/2026, 09:00 - 09:30 (Asia/Ho_Chi_Minh)" in the visitor's zone.
export const whenOf = (s: Slot, zone: string, locale: Locale) =>
  `${dayLabel(zonedDate(zone, Date.parse(s.start)), locale)}, ${timeIn(s.start, zone, locale)} - ${timeIn(s.end, zone, locale)} (${zone})`;

// While the week's free times load (DESIGN.md §5.3, #2005): a few days, each with a row of time buttons.
function SlotsSkeleton() {
  const t = useTranslations('common');
  return (
    <div aria-busy="true" className="space-y-3">
      <span className="sr-only">{t('loading')}</span>
      {[0, 1, 2].map((d) => (
        <div key={d} className="space-y-1.5">
          <Skeleton className="h-4 w-32" />
          <div className="flex flex-wrap gap-1">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-16 rounded-md" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// While a public booking page loads: the page's frame, its header (the org, the title, the length and place) and a card
// where the booking appears.
function PublicPageSkeleton() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-6 w-64 max-w-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <CardSkeleton />
    </main>
  );
}

// A week of the type's free slots, with the weeks before and after; picking one calls onPick. The bookings screen
// (#1320) uses it for a host's move too.
export function SlotPicker({ path, zone, onPick }: { path: string; zone: string; onPick: (slot: Slot) => void }) {
  const t = useTranslations('booking');
  const { locale } = useLocaleSetting();
  const [week, setWeek] = useState(0);
  const [now] = useState(() => Date.now());
  const range = weekRange(now, week, zone);
  const page = useQuery({
    queryKey: ['booking-page', path, range.from],
    queryFn: () => call<Page>(`${path}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
  });
  if (page.isLoading) return <SlotsSkeleton />;
  if (page.error) return <ErrorText>{errorMessage(page.error)}</ErrorText>;
  const days = slotsByDay(page.data?.slots ?? [], zone);
  return (
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
                  <Button key={s.start} type="button" variant="outline" size="sm" onClick={() => onPick(s)}>
                    {timeIn(s.start, zone, locale)}
                  </Button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
  // The API no longer knows the request (another page's token, or data erased): say so rather than wait.
  if (s === null) return <ErrorText>{t('requestNotFound')}</ErrorText>;
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

// A booking opened from a link in its mails: cancel it, or move it to another free slot of the type.
function Manage({ path, token, zone }: { path: string; token: string; zone: string }) {
  const t = useTranslations('booking');
  const { locale } = useLocaleSetting();
  const [mode, setMode] = useState<'view' | 'cancel' | 'move'>('view');
  const [asked, setAsked] = useState<string | null>(null);
  const [since, setSince] = useState(0);
  const view = useQuery({
    queryKey: ['booking-manage', path, token],
    queryFn: () => post<BookingManage>(path, { manage: token }),
    refetchInterval: (q) => (asked && q.state.data?.requestId === asked && q.state.data?.outcome === null && Date.now() - since < POLL_FOR_MS ? POLL_MS : false),
  });
  const ask = useMutation({
    mutationFn: (body: Record<string, unknown>) => post<{ requestId: string }>(path, { manage: token, ...body }),
    onSuccess: (r) => {
      setAsked(r?.requestId ?? null);
      setSince(Date.now());
      setMode('view');
      void view.refetch();
    },
  });
  useEffect(() => {
    document.title = view.data ? `${view.data.eventType.title} · ${view.data.orgName}` : t('title');
  }, [view.data, t]);

  if (view.isLoading) return <PublicPageSkeleton />;
  if (view.error) return <ErrorText>{errorMessage(view.error)}</ErrorText>;
  const b = view.data;
  if (!b) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <Logo />
        <p className="mt-6 text-sm text-muted-foreground">{t('manage.notFound')}</p>
      </main>
    );
  }
  const when = whenOf({ start: b.startsAt, end: b.endsAt }, zone, locale);
  const waiting = asked !== null && b.requestId === asked && b.outcome === null;
  const answered = asked !== null && b.requestId === asked ? b.outcome : null;
  let body;
  if (waiting) {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        {Date.now() - since < POLL_FOR_MS ? t('manage.working') : t('late')}
      </p>
    );
  } else if (answered === 'cancelled') {
    body = (
      <p className="text-sm text-foreground" role="status">
        {t('manage.cancelled')}
      </p>
    );
  } else if (answered === 'moved') {
    body = (
      <p className="text-sm text-foreground" role="status">
        {t('manage.moved', { when })}
      </p>
    );
  } else if (b.status === 'cancelled') {
    body = <p className="text-sm text-muted-foreground">{t('manage.isCancelled')}</p>;
  } else if (!b.usable) {
    body = <p className="text-sm text-muted-foreground">{t('manage.used')}</p>;
  } else if (mode === 'cancel') {
    body = (
      <div className="space-y-2">
        <p className="text-sm text-foreground">{t('manage.cancelConfirm')}</p>
        <div className="flex gap-2">
          <Button type="button" variant="destructive" disabled={ask.isPending} onClick={() => ask.mutate({ action: 'cancel' })}>
            {ask.isPending ? <Spinner className="text-current" /> : null}
            {t('manage.cancelYes')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode('view')}>
            {t('manage.keep')}
          </Button>
        </div>
      </div>
    );
  } else if (mode === 'move') {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-foreground">{t('manage.movePick')}</p>
        <SlotPicker path={path} zone={zone} onPick={(s) => !ask.isPending && ask.mutate({ action: 'move', startsAt: s.start })} />
        <Button type="button" variant="ghost" onClick={() => setMode('view')}>
          {t('manage.keep')}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-2">
        {answered === 'taken' || answered === 'unavailable' ? (
          <p className="text-sm text-foreground" role="alert">
            {answered === 'taken' ? t('taken') : t('unavailable')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {b.eventType.active ? (
            <Button type="button" variant="outline" onClick={() => setMode('move')}>
              {t('manage.move')}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => setMode('cancel')}>
            {t('manage.cancel')}
          </Button>
        </div>
        {!b.eventType.active ? <p className="text-sm text-muted-foreground">{t('manage.noMove')}</p> : null}
      </div>
    );
  }
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
      <header>
        <p className="text-sm text-muted-foreground">{b.orgName}</p>
        <h1 className="text-xl font-semibold text-foreground">{b.eventType.title}</h1>
        <p className="text-sm text-muted-foreground">
          {t('minutes', { count: String(b.eventType.durationMin) })} · {t(`locations.${b.eventType.locationKind}`)}
        </p>
      </header>
      <Card className="block space-y-3 p-4">
        <p className="text-sm font-medium text-foreground">{t('manage.title')}</p>
        <p className="text-sm text-foreground">{t('manage.when', { when })}</p>
        {body}
        {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
      </Card>
    </main>
  );
}

export function BookingPage({ org, type }: { org: string; type: string }) {
  const path = `/api/booking/${encodeURIComponent(org)}/${encodeURIComponent(type)}`;
  const [zone] = useState(visitorTimeZone);
  // The manage token is read once and kept in memory; the address bar loses it, so it is not left on screen.
  const [manage] = useState(() => manageTokenOf(window.location.hash));
  useEffect(() => {
    if (manage) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, [manage]);
  if (manage) return <Manage path={path} token={manage} zone={zone} />;
  return <Book path={path} zone={zone} />;
}

// Cloudflare Turnstile's widget (#1353), when the deployment sets a site key: it hands its token to onToken, and null
// when the token expires or the check fails. A new `round` renders a fresh widget (a token is good for one request).
function TurnstileWidget({ siteKey, round, onToken }: { siteKey: string; round: number; onToken: (token: string | null) => void }) {
  const t = useTranslations('booking');
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // The latest callback, so a parent's new function never re-renders the widget.
  const handToken = useRef(onToken);
  handToken.current = onToken;
  useEffect(() => {
    let widget: string | null = null;
    let gone = false;
    handToken.current(null);
    loadTurnstile()
      .then((api) => {
        if (gone || !box.current) return;
        widget = api.render(box.current, {
          sitekey: siteKey,
          callback: (token) => handToken.current(token),
          'expired-callback': () => handToken.current(null),
          'error-callback': () => handToken.current(null),
        });
      })
      .catch(() => setFailed(true));
    return () => {
      gone = true;
      const api = (window as { turnstile?: { remove(id: string): void } }).turnstile;
      if (widget && api) api.remove(widget);
    };
  }, [siteKey, round]);
  return (
    <div>
      <div ref={box} />
      {failed && <ErrorText>{t('checkFailed')}</ErrorText>}
    </div>
  );
}

function Book({ path, zone }: { path: string; zone: string }) {
  const t = useTranslations('booking');
  const { locale } = useLocaleSetting();
  const [now] = useState(() => Date.now());
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', note: '' });
  const [token, setToken] = useState<string | null>(null);
  const siteKey = getConfig().turnstileSiteKey ?? null;
  const [check, setCheck] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const range = weekRange(now, 0, zone);
  const page = useQuery({
    queryKey: ['booking-page', path, range.from],
    queryFn: () => call<Page>(`${path}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
  });
  const request = useMutation({
    mutationFn: (body: unknown) => post<{ token: string }>(path, body),
    onSuccess: (r) => setToken(r?.token ?? null),
    // The widget's token was spent on this request: a fresh one for the next try.
    onError: () => setRound((n) => n + 1),
  });
  useEffect(() => {
    document.title = page.data ? `${page.data.eventType.title} · ${page.data.orgName}` : t('title');
  }, [page.data, t]);

  // The visitor's name and email are checked here, in the page's own words under each field, on leaving it and on submit
  // (DESIGN.md §4.2, #2004), not by the browser; the server checks again.
  const fields = useFieldErrors<'name' | 'email'>((field) => {
    if (field === 'name') return form.name.trim() ? null : t('nameRequired');
    return !form.email.trim() ? t('emailRequired') : isEmailAddress(form.email) ? null : t('emailInvalid');
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['name', 'email'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    if (!slot || request.isPending || (siteKey && !check)) return;
    request.mutate({
      startsAt: slot.start,
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim() || null,
      note: form.note.trim() || null,
      timeZone: zone,
      ...(siteKey && check ? { turnstile: check } : {}),
    });
  };
  const again = () => {
    setToken(null);
    setSlot(null);
    request.reset();
    void page.refetch();
  };

  if (page.isLoading) return <PublicPageSkeleton />;
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
          <Followed path={path} token={token} when={whenOf(slot, zone, locale)} onAgain={again} />
        ) : slot ? (
          <form className="space-y-3" noValidate onSubmit={submit} aria-label={t('formTitle')}>
            <p className="text-sm text-foreground">{t('chosen', { when: whenOf(slot, zone, locale) })}</p>
            <div className="space-y-1">
              <Label htmlFor="booking-name">{t('name')}</Label>
              <Input
                {...fieldControl('booking-name', { error: Boolean(fields.of('name')) })}
                required
                maxLength={100}
                autoComplete="name"
                value={form.name}
                onChange={(e) => {
                  setForm({ ...form, name: e.target.value });
                  fields.edit('name');
                }}
                onBlur={(e) => fields.blur('name', e.target.value)}
              />
              <FieldError id="booking-name">{fields.of('name')}</FieldError>
            </div>
            <div className="space-y-1">
              <Label htmlFor="booking-email">{t('email')}</Label>
              <Input
                {...fieldControl('booking-email', { error: Boolean(fields.of('email')) })}
                required
                type="email"
                maxLength={254}
                autoComplete="email"
                value={form.email}
                onChange={(e) => {
                  setForm({ ...form, email: e.target.value });
                  fields.edit('email');
                }}
                onBlur={(e) => fields.blur('email', e.target.value)}
              />
              <FieldError id="booking-email">{fields.of('email')}</FieldError>
            </div>
            <div className="space-y-1">
              <Label htmlFor="booking-phone">{t('phone')}</Label>
              <Input id="booking-phone" type="tel" maxLength={30} autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="booking-note">{t('note')}</Label>
              <Textarea id="booking-note" rows={3} maxLength={1000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            {siteKey && <TurnstileWidget siteKey={siteKey} round={round} onToken={setCheck} />}
            <div className="flex gap-2">
              <Button type="submit" disabled={request.isPending || Boolean(siteKey && !check)}>
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
          <SlotPicker path={path} zone={zone} onPick={setSlot} />
        )}
      </Card>
    </main>
  );
}
