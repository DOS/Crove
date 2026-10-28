// The "Ghi chú" panel of a record (issue #1671, notes plan §3.10): its pinned notes first, then the latest three, and
// "Thêm ghi chú". On the org overview the record is the org itself (in a client company's org, the client): the org's
// pinned notes and its latest shared ones. On a party, the notes linked to it. A note written here is shared by default
// (decision N-7: a note about a client is usually for the team); "Chỉ mình tôi xem" keeps it private. Rendered only
// with the notes module on; each note opens on the notes screen.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { NoteLinkTargetInput, NoteSummary } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Textarea } from '@crove/ui/components/textarea';
import { VisibilityIcon } from '@crove/ui/components/visibility-icon';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { ErrorText, Spinner } from './ui.tsx';

const LATEST = 3;

export const notesInstalled = () => getConfig().modules.includes('notes');
export const refreshNotes = () => queryClient.invalidateQueries({ queryKey: orpc.notes.key() });

// The word beside the lock, always shown (notes plan §3.10).
export function VisibilityBadge({ note }: { note: Pick<NoteSummary, 'visibility'> }) {
  const t = useTranslations('notes');
  const shared = note.visibility === 'org';
  return (
    <Badge variant="outline" className="gap-1">
      <VisibilityIcon shared={shared} className="size-3.5" />
      {shared ? t('shared') : t('private')}
    </Badge>
  );
}

// The caller's role in the org: viewers write no note, and owners and admins also pin a shared one.
function useNotesRole(slug: string) {
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  return { writer: role !== undefined && role !== 'viewer', manager: role === 'owner' || role === 'admin' };
}

function PanelNote({ note, slug, mayPin }: { note: NoteSummary; slug: string; mayPin: boolean }) {
  const t = useTranslations('notes');
  const f = useFormat();
  const pin = useMutation({
    mutationFn: () => (note.pinned ? client.notes.unpin({ noteId: note.id }) : client.notes.pin({ noteId: note.id })),
    onSuccess: refreshNotes,
  });
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm" data-testid="note-item">
      <Link to="/o/$slug/notes" params={{ slug }} search={{ note: note.id }} className="min-w-0 flex-1 truncate font-medium text-foreground hover:underline">
        {note.title}
      </Link>
      {note.pinned && <Badge variant="secondary">{t('pinnedBadge')}</Badge>}
      <VisibilityBadge note={note} />
      <span className="text-xs text-subtle-foreground">{f.date(note.updatedAt)}</span>
      {mayPin && (
        <Button variant="ghost" size="sm" disabled={pin.isPending} onClick={() => pin.mutate()} aria-label={t(note.pinned ? 'unpinOf' : 'pinOf', { title: note.title })}>
          {note.pinned ? t('unpin') : t('pin')}
        </Button>
      )}
      {pin.error && <ErrorText>{errorMessage(pin.error)}</ErrorText>}
    </li>
  );
}

function AddNote({ target, onDone }: { target: NoteLinkTargetInput | undefined; onDone: () => void }) {
  const t = useTranslations('notes');
  const id = useId();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [onlyMe, setOnlyMe] = useState(false);
  // The values go in as the mutation's variables, so a field changed while it is out cannot change what it sends.
  const create = useMutation({
    mutationFn: (note: { title: string; body: string; visibility: 'private' | 'org' }) => client.notes.create({ ...note, ...(target ? { link: target } : {}) }),
    onSuccess: () => {
      void refreshNotes();
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim() !== '' && !create.isPending) create.mutate({ title, body, visibility: onlyMe ? 'private' : 'org' });
  };
  return (
    <form onSubmit={submit} className="space-y-2 px-4 py-3">
      <label htmlFor={`${id}-title`} className="sr-only">
        {t('panel.addTitle')}
      </label>
      <Input id={`${id}-title`} value={title} maxLength={200} placeholder={t('panel.addTitle')} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <label htmlFor={`${id}-body`} className="sr-only">
        {t('panel.addBody')}
      </label>
      <Textarea id={`${id}-body`} value={body} rows={3} placeholder={t('panel.addBody')} onChange={(e) => setBody(e.target.value)} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} />
          {t('panel.privateOnly')}
        </label>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            {t('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={title.trim() === '' || create.isPending}>
            {create.isPending && <Spinner className="text-current" />}
            {t('panel.save')}
          </Button>
        </div>
      </div>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </form>
  );
}

// label: the region's name when several panels may be open at once (one per party row), so each is told apart.
function PanelBody({
  slug,
  target,
  headingId,
  label,
  className,
  notes,
  error,
  empty,
}: {
  slug: string;
  target: NoteLinkTargetInput | undefined;
  headingId: string;
  label?: string;
  className?: string;
  notes: NoteSummary[] | null;
  error: unknown;
  // What an empty panel says, when the record is not a client (a document, a voucher, a booking).
  empty?: string;
}) {
  const t = useTranslations('notes');
  const { writer, manager } = useNotesRole(slug);
  const [adding, setAdding] = useState(false);
  return (
    <section className={className} {...(label ? { 'aria-label': label } : { 'aria-labelledby': headingId })}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold">
          {t('panel.title')}
        </h2>
        <Link to="/o/$slug/notes" params={{ slug }} className="text-xs text-link underline">
          {t('panel.all')}
        </Link>
      </div>
      <Card className="mt-3 block overflow-hidden p-0">
        {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}
        {notes === null && !error ? (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-subtle-foreground">
            <Spinner /> {t('loading')}
          </p>
        ) : notes && notes.length > 0 ? (
          <ul className="divide-y">
            {notes.map((n) => (
              <PanelNote key={n.id} note={n} slug={slug} mayPin={writer && (n.mine || (n.visibility === 'org' && manager))} />
            ))}
          </ul>
        ) : (
          !error && <p className="px-4 py-3 text-sm text-subtle-foreground">{empty ?? t('panel.empty')}</p>
        )}
        {writer && (
          <div className="border-t">
            {adding ? (
              <AddNote target={target} onDone={() => setAdding(false)} />
            ) : (
              <div className="px-4 py-3">
                <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                  {t('panel.add')}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}

// The org overview's panel: the org itself is the record, so its pinned notes, then its latest shared ones.
export function OrgNotesPanel({ slug }: { slug: string }) {
  const pinned = useQuery(orpc.notes.list.queryOptions({ input: { view: 'pinned', limit: 20 } }));
  // The list puts pinned notes first, so it reads as many as it may and keeps the unpinned ones.
  const shared = useQuery(orpc.notes.list.queryOptions({ input: { view: 'shared', limit: 200 } }));
  const notes = pinned.data && shared.data ? [...pinned.data, ...shared.data.filter((n) => !n.pinned).slice(0, LATEST)] : null;
  return <PanelBody slug={slug} target={undefined} headingId="overview-notes" className="mt-8" notes={notes} error={pinned.error ?? shared.error} />;
}

// A record's panel (a party, a document, a voucher, a booking): the notes linked to it.
export function RecordNotesPanel({ slug, target, headingId, label, empty }: { slug: string; target: NoteLinkTargetInput; headingId: string; label: string; empty?: string }) {
  const panel = useQuery(orpc.notes.panel.queryOptions({ input: target }));
  const notes = panel.data ? [...panel.data.pinned, ...panel.data.latest] : null;
  return <PanelBody slug={slug} target={target} headingId={headingId} label={label} notes={notes} error={panel.error} {...(empty !== undefined ? { empty } : {})} />;
}

// Before an owner removes a member (ADR-0037 §4): how many private notes they have, which nobody reads once they leave
// and which are removed 30 days later. A count only. `ready` holds the removal back until the count is in, so the
// warning is never skipped; a count that fails to load says so and lets the removal go on.
export function usePrivateNotes(userId: string) {
  const on = notesInstalled();
  const counts = useQuery({ ...orpc.notes.privateCounts.queryOptions({ input: {} }), enabled: on });
  return { ready: !on || counts.isSuccess || counts.isError, failed: counts.isError, count: counts.data?.find((c) => c.userId === userId)?.notes ?? 0 };
}

export function MemberPrivateNotes({ notes }: { notes: ReturnType<typeof usePrivateNotes> }) {
  const t = useTranslations('notes');
  if (notes.failed) return <p className="text-foreground">{t('memberPrivateUnknown')}</p>;
  if (notes.count === 0) return null;
  return <p className="text-foreground">{t('memberPrivate', { count: notes.count })}</p>;
}
