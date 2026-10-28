// The notes screen (issue #1671, plan docs/plan/notes.md §3.10): the lists on the left (Của tôi, Dùng chung, Đã ghim,
// Lưu trữ, Thùng rác) with a search, the open note on the right; on a narrow screen the list and the note take turns.
// The author edits the title, Markdown body and tags, which save by themselves a pause after the last keystroke against
// the revision they read (lib/note-autosave.ts; a note changed elsewhere asks to reload), and makes it private or
// shared. The lock and the word "Riêng tư" or "Dùng chung" are always beside the title. Owners and admins may pin,
// archive or delete a shared note; viewers write nothing. The server and the row policies decide; the screen only
// hides what can never succeed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { NOTE_LIST_VIEWS, type Note, type NoteListView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Textarea } from '@crove/ui/components/textarea';
import { NoteLinks } from '../components/note-links.tsx';
import { VisibilityBadge, refreshNotes } from '../components/notes-panel.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, clientForOrg, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { Markdown } from '../lib/markdown.tsx';
import { createAutosaver, type NoteValues, type SaveState } from '../lib/note-autosave.ts';
import { looksLikePassword, parseTags, type NotesSearch } from '../lib/notes.ts';

const SAVE_AFTER_MS = 800;
const isConflict = (error: unknown) => (error as { code?: string } | null)?.code === 'NOTE_REVISION_CONFLICT';
const valuesOf = (note: Note): NoteValues => ({ title: note.title, body: note.body, tags: note.tags.join(', ') });

function Editor({ note, slug, role, back, focusTitle }: { note: Note; slug: string; role: string | undefined; back: NotesSearch; focusTitle: boolean }) {
  const t = useTranslations('notes');
  const f = useFormat();
  const navigate = useNavigate();
  const [values, setValues] = useState<NoteValues>(() => valuesOf(note));
  const [preview, setPreview] = useState(!note.mine);
  const [state, setState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<unknown>(null);
  const [confirmShare, setConfirmShare] = useState(false);
  // Bound to the note's org: a save that runs as the editor closes, after the user switched org, still goes to its own.
  const api = useRef(clientForOrg(slug)).current;
  const saver = useRef(
    createAutosaver({
      revision: note.revision,
      delayMs: SAVE_AFTER_MS,
      save: async (revision, v) => (await api.notes.update({ noteId: note.id, revision, title: v.title, body: v.body, tags: parseTags(v.tags) })).revision,
      isConflict,
      onState: (next, error) => {
        setState(next);
        if (error !== undefined) setSaveError(error);
        if (next === 'saved') void refreshNotes();
      },
    }),
  ).current;
  const manager = role === 'owner' || role === 'admin';
  const writer = role !== undefined && role !== 'viewer';
  const mayManage = writer && (note.mine || (note.visibility === 'org' && manager));
  const inTrash = note.deletedAt !== null;
  const editable = note.mine && writer && !inTrash;

  // A change made elsewhere (another tab, the stream's refetch) replaces the text while nothing waits to save.
  useEffect(() => {
    if (saver.dirty() || saver.busy() || note.revision === saver.revision()) return;
    saver.reset(note.revision);
    setValues(valuesOf(note));
  }, [note, saver]);
  // Leaving the note (another note, the list, another screen) or the page saves what waits.
  useEffect(() => {
    const away = () => {
      if (document.visibilityState === 'hidden') void saver.flush();
    };
    const leave = () => void saver.flush();
    document.addEventListener('visibilitychange', away);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', away);
      window.removeEventListener('pagehide', leave);
      void saver.flush();
      saver.dispose();
    };
  }, [saver]);

  const edit = (patch: Partial<NoteValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    saver.edit(next);
  };
  // The server's copy, read again whatever the cache holds, replaces the text (after a conflict).
  const reload = async () => {
    const fresh = await queryClient.fetchQuery({ ...orpc.notes.get.queryOptions({ input: { noteId: note.id } }), staleTime: 0 });
    saver.reset(fresh.revision);
    setValues(valuesOf(fresh));
  };

  const act = useMutation({
    mutationFn: async (action: 'pin' | 'unpin' | 'archive' | 'restore' | 'delete' | 'share' | 'unshare') => {
      const ref = { noteId: note.id };
      if (action === 'share' || action === 'unshare') {
        // Sharing moves the revision on: the text waiting to save goes first, so the two never conflict.
        await saver.settle();
        return api.notes.setVisibility({ ...ref, visibility: action === 'share' ? 'org' : 'private' });
      }
      return api.notes[action](ref);
    },
    onSuccess: (done, action) => {
      setConfirmShare(false);
      if (action === 'share' || action === 'unshare') saver.setRevision(done.revision);
      void refreshNotes();
      if (action === 'delete' || action === 'archive') void navigate({ to: '/o/$slug/notes', params: { slug }, search: back });
    },
  });
  const blocked = act.isPending || state === 'saving';

  return (
    <article className="space-y-4" aria-labelledby="note-title">
      <div className="flex flex-wrap items-center gap-2">
        <VisibilityBadge note={note} />
        {note.pinned && <Badge variant="secondary">{t('pinnedBadge')}</Badge>}
        {note.archivedAt && <Badge variant="outline">{t('archivedBadge')}</Badge>}
        {inTrash && <Badge variant="destructive">{t('trashBadge')}</Badge>}
        <span className="text-xs text-subtle-foreground">{note.mine ? t('byMe') : t('byOther')}</span>
        <span className="text-xs text-subtle-foreground">{t('updated', { when: f.dateTime(note.updatedAt) })}</span>
        <span className="ml-auto text-xs text-subtle-foreground" role="status">
          {state === 'saving' ? t('saving') : state === 'saved' ? t('saved') : ''}
        </span>
      </div>

      {editable ? (
        <>
          <label htmlFor="note-title" className="sr-only">
            {t('titleLabel')}
          </label>
          <Input id="note-title" value={values.title} maxLength={200} autoFocus={focusTitle} onChange={(e) => edit({ title: e.target.value })} className="text-base font-semibold" />
          <div className="flex items-center gap-2">
            <Button variant={preview ? 'ghost' : 'outline'} size="sm" onClick={() => setPreview(false)} aria-pressed={!preview}>
              {t('write')}
            </Button>
            <Button variant={preview ? 'outline' : 'ghost'} size="sm" onClick={() => setPreview(true)} aria-pressed={preview}>
              {t('preview')}
            </Button>
          </div>
          {preview ? (
            <div className="min-h-40 rounded-md border px-3 py-2">
              {values.body.trim() === '' ? <p className="text-sm text-subtle-foreground">{t('emptyBody')}</p> : <Markdown text={values.body} />}
            </div>
          ) : (
            <>
              <label htmlFor="note-body" className="sr-only">
                {t('bodyLabel')}
              </label>
              <Textarea id="note-body" value={values.body} rows={14} maxLength={100_000} onChange={(e) => edit({ body: e.target.value })} placeholder={t('bodyPlaceholder')} className="font-mono text-sm" />
            </>
          )}
          {looksLikePassword(`${values.title}\n${values.body}`) && (
            <p role="note" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground">
              {t('passwordWarning')}
            </p>
          )}
          <div className="space-y-1">
            <label htmlFor="note-tags" className="text-xs font-medium text-muted-foreground">
              {t('tagsLabel')}
            </label>
            <Input id="note-tags" value={values.tags} onChange={(e) => edit({ tags: e.target.value })} placeholder={t('tagsHint')} />
          </div>
        </>
      ) : (
        <>
          <h2 id="note-title" className="text-lg font-semibold text-foreground">
            {note.title}
          </h2>
          {note.body.trim() === '' ? <p className="text-sm text-subtle-foreground">{t('emptyBody')}</p> : <Markdown text={note.body} />}
          {note.tags.length > 0 && (
            <p className="flex flex-wrap gap-1">
              {note.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </p>
          )}
          {!note.mine && <p className="text-xs text-subtle-foreground">{t('readOnly')}</p>}
        </>
      )}

      <NoteLinks links={note.links} slug={slug} />

      {state === 'conflict' && (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <ErrorText>{t('conflict')}</ErrorText>
          <Button size="sm" variant="outline" onClick={() => void reload()}>
            {t('reload')}
          </Button>
        </div>
      )}
      {state === 'error' && <ErrorText>{errorMessage(saveError)}</ErrorText>}

      {confirmShare && (
        <div className="space-y-2 rounded-lg border p-3 text-sm" role="alertdialog" aria-label={t('shareTitle')}>
          <p className="text-foreground">{t('shareConfirm')}</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={blocked} onClick={() => act.mutate('share')}>
              {t('makeShared')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmShare(false)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {mayManage && (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          {inTrash ? (
            <Button size="sm" variant="outline" disabled={blocked} onClick={() => act.mutate('restore')}>
              {t('restore')}
            </Button>
          ) : (
            <>
              {note.mine && !confirmShare && (
                <Button size="sm" variant="outline" disabled={blocked} onClick={() => (note.visibility === 'org' ? act.mutate('unshare') : setConfirmShare(true))}>
                  {note.visibility === 'org' ? t('makePrivate') : t('makeShared')}
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={blocked} onClick={() => act.mutate(note.pinned ? 'unpin' : 'pin')}>
                {note.pinned ? t('unpin') : t('pin')}
              </Button>
              <Button size="sm" variant="outline" disabled={blocked} onClick={() => act.mutate(note.archivedAt ? 'restore' : 'archive')}>
                {note.archivedAt ? t('restore') : t('archive')}
              </Button>
              <Button size="sm" variant="ghost" disabled={blocked} onClick={() => act.mutate('delete')}>
                {t('delete')}
              </Button>
            </>
          )}
          {act.isPending && <Spinner />}
        </div>
      )}
      {act.error && <ErrorText>{errorMessage(act.error)}</ErrorText>}
      {inTrash && <p className="text-xs text-subtle-foreground">{t('trashHint')}</p>}
    </article>
  );
}

export function NotesPage() {
  const t = useTranslations('notes');
  const f = useFormat();
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search: NotesSearch = useSearch({ strict: false });
  const view: NoteListView = search.list ?? 'mine';
  const [q, setQ] = useState(search.q ?? '');
  // Back and forward change the address, and the search box follows it.
  useEffect(() => setQ(search.q ?? ''), [search.q]);
  const [created, setCreated] = useState<string | null>(null);
  const go = (next: NotesSearch) => void navigate({ to: '/o/$slug/notes', params: { slug }, search: next });
  const back: NotesSearch = search.q ? { q: search.q } : { list: view };

  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const writer = role !== undefined && role !== 'viewer';
  const list = useQuery({ ...orpc.notes.list.queryOptions({ input: { view } }), enabled: !search.q });
  const found = useQuery({ ...orpc.notes.search.queryOptions({ input: { q: search.q ?? '' } }), enabled: Boolean(search.q) });
  const notes = search.q ? found : list;
  const open = useQuery({ ...orpc.notes.get.queryOptions({ input: { noteId: search.note ?? '' } }), enabled: Boolean(search.note) });
  const create = useMutation({
    mutationFn: () => client.notes.create({ title: t('newTitle') }),
    onSuccess: (done) => {
      void refreshNotes();
      setCreated(done.noteId);
      go({ list: 'mine', note: done.noteId });
    },
  });
  const newButton = writer ? (
    <Button onClick={() => create.mutate()} disabled={create.isPending}>
      {create.isPending && <Spinner className="text-current" />}
      {t('new')}
    </Button>
  ) : undefined;

  return (
    <div>
      <PageHeader title={t('title')} subtitle={t('subtitle')} actions={newButton} />
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <section aria-label={t('listLabel')} className={search.note ? 'hidden lg:block' : undefined}>
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              go(q.trim() ? { q: q.trim() } : { list: view });
            }}
          >
            <label htmlFor="notes-search" className="sr-only">
              {t('search')}
            </label>
            <Input id="notes-search" type="search" value={q} placeholder={t('search')} onChange={(e) => setQ(e.target.value)} />
          </form>
          {!search.q && (
            <Tabs value={view} onValueChange={(v) => go({ list: v as NoteListView })} className="mt-3">
              <TabsList className="flex h-auto flex-wrap">
                {NOTE_LIST_VIEWS.map((v) => (
                  <TabsTrigger key={v} value={v}>
                    {t(`views.${v}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          {search.q && (
            <p className="mt-3 text-xs text-subtle-foreground">
              {t('searchingFor', { q: search.q })}{' '}
              <button type="button" className="text-link underline" onClick={() => go({ list: view })}>
                {t('clearSearch')}
              </button>
            </p>
          )}
          <div className="mt-3">
            {notes.error && <ErrorText>{errorMessage(notes.error)}</ErrorText>}
            {notes.isPending && !notes.error ? (
              <ListSkeleton />
            ) : notes.data && notes.data.length === 0 ? (
              <Empty title={search.q ? t('searchEmpty') : t('emptyTitle')} hint={t('emptyScreenHint')} action={search.q ? undefined : newButton} />
            ) : (
              <ul className="divide-y rounded-lg border">
                {notes.data?.map((n) => (
                  <li key={n.id}>
                    <Link
                      to="/o/$slug/notes"
                      params={{ slug }}
                      search={{ ...back, note: n.id }}
                      className="block px-3 py-2 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 aria-[current=page]:bg-muted"
                      aria-current={n.id === search.note ? 'page' : undefined}
                      data-testid="note-row"
                    >
                      <span className="block truncate font-medium text-foreground">{n.title}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-subtle-foreground">
                        <VisibilityBadge note={n} />
                        {n.pinned && <Badge variant="secondary">{t('pinnedBadge')}</Badge>}
                        {f.date(n.updatedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section aria-label={t('noteLabel')} className={search.note ? undefined : 'hidden lg:block'}>
          {search.note && (
            <Link to="/o/$slug/notes" params={{ slug }} search={back} className="mb-3 inline-block text-sm text-link underline lg:hidden">
              {t('back')}
            </Link>
          )}
          {!search.note ? (
            <Empty title={t('pick')} />
          ) : open.error ? (
            <ErrorText>{errorMessage(open.error)}</ErrorText>
          ) : open.data ? (
            <Editor key={open.data.id} note={open.data} slug={slug} role={role} back={back} focusTitle={created === open.data.id} />
          ) : (
            <ListSkeleton />
          )}
        </section>
      </div>
    </div>
  );
}
