// The bookings screen (#1320, plan docs/plan/calendar.md step C5): the bookings of the public booking page, upcoming and
// past. A member sees those of the event types they host or that are on their calendar (a team type's, #1373); owners
// and admins may see the whole org's. A host (or an owner or admin) cancels a booking, or moves it to another free slot
// of its type; the visitor is mailed with a new link. Times show in the viewer's own zone; each row names its hosts.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BookingItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { BookingFeedCard } from '../components/booking-feed.tsx';
import { BookingSuggestCard } from '../components/booking-suggest.tsx';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner, TableSkeleton } from '../components/ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { visitorTimeZone } from '../lib/booking.ts';
import { SlotPicker, whenOf } from './booking-page.tsx';

type Period = 'upcoming' | 'past';
type Scope = 'mine' | 'org';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.crm.bookings.list.key() });

function Actions({ booking, slug, zone }: { booking: BookingItem; slug: string; zone: string }) {
  const t = useTranslations('bookings');
  const [mode, setMode] = useState<'none' | 'cancel' | 'move'>('none');
  const done = () => {
    setMode('none');
    void refresh();
  };
  const cancel = useMutation(orpc.crm.bookings.cancel.mutationOptions({ onSuccess: done }));
  const move = useMutation(orpc.crm.bookings.move.mutationOptions({ onSuccess: done }));
  // Only the error of the action shown: a failed cancel is not left on the move picker.
  const error = mode === 'cancel' ? cancel.error : mode === 'move' ? move.error : null;
  if (mode === 'cancel') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-foreground">{t('cancelConfirm')}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate({ bookingId: booking.id })}>
            {cancel.isPending ? <Spinner className="text-current" /> : null}
            {t('cancelYes')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode('none')}>
            {t('keep')}
          </Button>
        </div>
        {error && <ErrorText>{errorMessage(error)}</ErrorText>}
      </div>
    );
  }
  if (mode === 'move') {
    const path = `/api/booking/${encodeURIComponent(slug)}/${encodeURIComponent(booking.eventType.slug)}`;
    return (
      <div className="space-y-2">
        <p className="text-sm text-foreground">{t('movePick')}</p>
        <SlotPicker path={path} zone={zone} onPick={(s) => !move.isPending && move.mutate({ bookingId: booking.id, startsAt: s.start })} />
        <Button size="sm" variant="ghost" onClick={() => setMode('none')}>
          {t('keep')}
        </Button>
        {error && <ErrorText>{errorMessage(error)}</ErrorText>}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {booking.eventType.active ? (
        <Button size="sm" variant="outline" onClick={() => setMode('move')}>
          {t('move')}
        </Button>
      ) : null}
      <Button size="sm" variant="outline" onClick={() => setMode('cancel')}>
        {t('cancel')}
      </Button>
    </div>
  );
}

// A booking's row and, when opened, its notes below it (#1672): the notes linked to this booking and "Thêm ghi chú".
function BookingRow({
  b,
  slug,
  zone,
  locale,
  now,
  nameOf,
}: {
  b: BookingItem;
  slug: string;
  zone: string;
  locale: Parameters<typeof whenOf>[2];
  now: number;
  nameOf: (userId: string) => string | null;
}) {
  const t = useTranslations('bookings');
  const tn = useTranslations('notes');
  const [notesOpen, setNotesOpen] = useState(false);
  const when = whenOf({ start: b.startsAt, end: b.endsAt }, zone, locale);
  const name = `${b.eventType.title}, ${when}`;
  return (
    <>
      <TableRow data-testid="booking-row">
        <TableCell className="px-4 text-sm">{when}</TableCell>
        <TableCell className="px-4 text-sm">
          <p>{b.eventType.title}</p>
          <p className="text-xs text-muted-foreground">
            {b.hostUserIds
              .map(nameOf)
              .filter((n): n is string => n !== null)
              .join(', ')}
          </p>
        </TableCell>
        <TableCell className="px-4 text-sm">
          <p className="font-medium text-foreground">{b.visitor.name ?? t('erased')}</p>
          {b.visitor.email && <p className="text-xs text-muted-foreground">{b.visitor.email}</p>}
          {b.visitor.phone && <p className="text-xs text-muted-foreground">{b.visitor.phone}</p>}
          {b.visitor.note && <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{b.visitor.note}</p>}
        </TableCell>
        <TableCell className="px-4">
          <Badge variant={b.status === 'confirmed' ? 'success' : 'outline'}>{t(`status.${b.status === 'confirmed' ? 'confirmed' : 'cancelled'}`)}</Badge>
        </TableCell>
        <TableCell className="px-4">
          <div className="flex flex-wrap items-start gap-1">
            {b.status === 'confirmed' && Date.parse(b.startsAt) > now && <Actions booking={b} slug={slug} zone={zone} />}
            {notesInstalled() && (
              <Button size="sm" variant="ghost" onClick={() => setNotesOpen((o) => !o)} aria-expanded={notesOpen} aria-label={tn('panel.toggleOf', { name })}>
                {tn('panel.title')}
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
      {notesOpen && (
        <TableRow>
          <TableCell colSpan={5} className="px-4 py-3">
            <RecordNotesPanel
              slug={slug}
              target={{ targetType: 'crm.booking', targetId: b.id }}
              headingId={`notes-${b.id}`}
              label={tn('panel.toggleOf', { name })}
              empty={tn('panel.emptyRecord')}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function BookingsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('bookings');
  const { locale } = useLocaleSetting();
  const [zone] = useState(visitorTimeZone);
  const [period, setPeriod] = useState<Period>('upcoming');
  const [scope, setScope] = useState<Scope>('mine');
  const org = useQuery(orpc.org.get.queryOptions());
  const manager = org.data?.role === 'owner' || org.data?.role === 'admin';
  const bookings = useQuery({ ...orpc.crm.bookings.list.queryOptions({ input: { scope: manager ? scope : 'mine', period } }), enabled: org.data !== undefined });
  const now = Date.now();
  const names = new Map((org.data?.members ?? []).map((m) => [m.userId, m.displayName ?? m.email]));
  const nameOf = (userId: string) => names.get(userId) ?? null;

  return (
    <div>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {org.data && org.data.role !== 'viewer' && <BookingFeedCard />}
      {org.data && org.data.role !== 'viewer' && <BookingSuggestCard slug={slug} />}
      <div className="mb-4 flex flex-wrap gap-2">
        <Tabs value={period} onValueChange={(value) => setPeriod(value as Period)}>
          <TabsList>
            <TabsTrigger value="upcoming">{t('upcoming')}</TabsTrigger>
            <TabsTrigger value="past">{t('past')}</TabsTrigger>
          </TabsList>
        </Tabs>
        {manager && (
          <Tabs value={scope} onValueChange={(value) => setScope(value as Scope)}>
            <TabsList>
              <TabsTrigger value="mine">{t('mine')}</TabsTrigger>
              <TabsTrigger value="org">{t('org')}</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{t('zone', { zone })}</p>
      {org.error || bookings.error ? (
        <ErrorText>{errorMessage(org.error ?? bookings.error)}</ErrorText>
      ) : !bookings.data ? (
        <TableSkeleton columns={5} />
      ) : bookings.data.length === 0 ? (
        <Empty title={t(period === 'upcoming' ? 'emptyUpcoming' : 'emptyPast')} hint={t('emptyHint')} />
      ) : (
        <DataTable head={[t('colWhen'), t('colType'), t('colVisitor'), t('colStatus'), '']}>
          {bookings.data.map((b) => (
            <BookingRow key={b.id} b={b} slug={slug} zone={zone} locale={locale} now={now} nameOf={nameOf} />
          ))}
        </DataTable>
      )}
    </div>
  );
}
