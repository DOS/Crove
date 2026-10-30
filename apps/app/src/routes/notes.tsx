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
import { NOTE_BODY_MAX, NOTE_LIST_VIEWS, type Note, type NoteListView } from '@crove/kernel-contract';
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
import { applyFormat, shortcutFormat, type MarkdownFormat } from '../lib/markdown-edit.ts';
import { createAutosaver, type Autosaver, type NoteValues, type SaveState } from '../lib/note-autosave.ts';
import { notesMarkdown, saveText } from '../lib/notes-export.ts';
import { listOfNote, looksLikePassword, parseTags, tagCounts, type NotesSearch } from '../lib/notes.ts';

const SAVE_AFTER_MS = 800;
const isConflict = (error: unknown) => (error as { code?: string } | null)?.code === 'NOTE_REVISION_CONFLICT';
const valuesOf = (note: Note): NoteValues => ({ title: note.title, body: note.body, tags: note.tags.join(', ') });

// Each format's key, and its shortcut as aria-keyshortcuts names it (Ctrl, or Cmd on a Mac).
const FORMATS: ReadonlyArray<{ format: MarkdownFormat; key: string; aria: string }> = [
  { format: 'bold', key: 'B', aria: 'Control+B Meta+B' },
  { format: 'list', key: 'Shift+8', aria: 'Control+Shift+8 Meta+Shift+8' },
  { format: 'task', key: 'Shift+9', aria: 'Control+Shift+9 Meta+Shift+9' },
  { format: 'link', key: 'K', aria: 'Control+K Meta+K' },
];
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';

// A note's tags as buttons: each shows the notes with that tag (#1739).
// The open editors' savers: a download first saves what they hold (#1678), so the file has what the screen shows.
const openSavers = new Set<Autosaver>();

function TagChips({ tags, onTag }: { tags: readonly string[]; onTag: (tag: string) => void }) {
  const t = useTranslations('notes');
  if (tags.length === 0) return null;
  return (
    <p className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Button key={tag} variant="outline" size="sm" className="h-auto rounded-full px-2 py-0.5 text-xs" onClick={() => onTag(tag)} aria-label={t('tagShow', { tag })}>
          {tag}
        </Button>
      ))}
    </p>
  );
}

function Editor({
  note,
  slug,
  role,
  back,
  focusTitle,
  onTag,
}: {
  note: Note;
  slug: string;
  role: string | undefined;
  back: NotesSearch;
  focusTitle: boolean;
  onTag: (tag: string) => void;
}) {
  const t = useTranslations('notes');
  const f = useFormat();
  const navigate = useNavigate();
  const [values, setValues] = useState<NoteValues>(() => valuesOf(note));
  const [preview, setPreview] = useState(!note.mine);
  const [state, setState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<unknown>(null);
  const [confirmShare, setConfirmShare] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
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
    openSavers.add(saver);
    return () => {
      openSavers.delete(saver);
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
  // The toolbar and its shortcuts (#1739): Markdown at the cursor, the selection kept where the member expects it.
  const format = (kind: MarkdownFormat) => {
    const el = bodyRef.current;
    if (!el) return;
    const next = applyFormat({ value: values.body, start: el.selectionStart, end: el.selectionEnd }, kind);
    // A value set from code is not held to the textarea's maxLength; the server would refuse a longer body.
    if (next.value.length > NOTE_BODY_MAX) return;
    edit({ body: next.value });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
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
              <div role="group" aria-label={t('toolbar.label')} className="flex flex-wrap gap-1">
                {FORMATS.map(({ format: kind, key, aria }) => (
                  <Button
                    key={kind}
                    variant="ghost"
                    size="sm"
                    // Keeps the textarea's selection: the button takes no focus from it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => format(kind)}
                    aria-keyshortcuts={aria}
                    title={t(`toolbar.${kind}Hint`, { keys: `${MOD}${key}` })}
                  >
                    {t(`toolbar.${kind}`)}
                  </Button>
                ))}
              </div>
              <label htmlFor="note-body" className="sr-only">
                {t('bodyLabel')}
              </label>
              <Textarea
                id="note-body"
                ref={bodyRef}
                value={values.body}
                rows={14}
                maxLength={NOTE_BODY_MAX}
                onChange={(e) => edit({ body: e.target.value })}
                onKeyDown={(e) => {
                  const kind = shortcutFormat({ ...e, code: e.code, isComposing: e.nativeEvent.isComposing });
                  if (!kind) return;
                  e.preventDefault();
                  // Ctrl+K also opens the command palette from the window; here it is the editor's.
                  e.stopPropagation();
                  format(kind);
                }}
                placeholder={t('bodyPlaceholder')}
                className="font-mono text-sm"
              />
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
            <TagChips tags={note.tags} onTag={onTag} />
          </div>
        </>
      ) : (
        <>
          <h2 id="note-title" className="text-lg font-semibold text-foreground">
            {note.title}
          </h2>
          {note.body.trim() === '' ? <p className="text-sm text-subtle-foreground">{t('emptyBody')}</p> : <Markdown text={note.body} />}
          <TagChips tags={note.tags} onTag={onTag} />
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
  // A tag filters the lists, not a search.
  const tag = search.q ? undefined : search.tag;
  const back: NotesSearch = search.q ? { q: search.q } : { list: view, ...(tag ? { tag } : {}) };

  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const writer = role !== undefined && role !== 'viewer';
  // The whole list gives the tag chips; with a tag chosen, the filtered list is the one shown.
  const all = useQuery({ ...orpc.notes.list.queryOptions({ input: { view } }), enabled: !search.q });
  const tagged = useQuery({ ...orpc.notes.list.queryOptions({ input: { view, tag: tag ?? '' } }), enabled: !search.q && tag !== undefined });
  const list = tag ? tagged : all;
  const chips = tagCounts(all.data ?? []);
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
  // My own notes and to-dos, whole, as a file (#1678): whoever has a role in the org, a viewer who once wrote notes too.
  // Edits still waiting to save go first (a failed save shows in its editor; the file then has the saved text).
  const exportMine = useMutation({
    mutationFn: async (_format: 'md' | 'json') => {
      await Promise.allSettled([...openSavers].map((s) => s.flush()));
      return client.notes.exportMine({});
    },
  });
  const download = async (format: 'md' | 'json') => {
    const data = await exportMine.mutateAsync(format);
    // The org and the day on this device's clock in the name, so files of two orgs or two days never clash.
    const name = `${t('export.fileName')}-${slug}-${new Date().toLocaleDateString('sv-SE')}`;
    if (format === 'json') {
      saveText(`${name}.json`, `${JSON.stringify(data, null, 2)}\n`, 'application/json');
      return;
    }
    const words = {
      heading: t('export.heading'),
      exportedAt: t('export.exportedAt'),
      notes: t('export.notes'),
      todos: t('export.todos'),
      private: t('export.private'),
      shared: t('export.shared'),
      tags: t('export.tags'),
      pinned: t('export.pinned'),
      archived: t('export.archived'),
      trashed: t('export.trashed'),
      created: t('export.created'),
      updated: t('export.updated'),
      links: t('export.links'),
      status: { open: t('export.status.open'), done: t('export.status.done'), handed_over: t('export.status.handed_over'), cancelled: t('export.status.cancelled') },
      due: t('export.due'),
      remind: t('export.remind'),
      done: t('export.done'),
      truncated: t('export.truncated'),
    };
    saveText(`${name}.md`, notesMarkdown(data, words), 'text/markdown;charset=utf-8');
  };
  const actions =
    role !== undefined ? (
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={exportMine.isPending} onClick={() => void download('md').catch(() => undefined)}>
          {exportMine.isPending && exportMine.variables === 'md' && <Spinner className="text-current" />}
          {t('export.markdown')}
        </Button>
        <Button variant="outline" disabled={exportMine.isPending} onClick={() => void download('json').catch(() => undefined)}>
          {exportMine.isPending && exportMine.variables === 'json' && <Spinner className="text-current" />}
          {t('export.json')}
        </Button>
        {newButton}
      </div>
    ) : undefined;

  return (
    <div>
      <PageHeader title={t('title')} subtitle={t('subtitle')} actions={actions} />
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      {exportMine.error && <ErrorText>{errorMessage(exportMine.error)}</ErrorText>}
      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <section aria-label={t('listLabel')} className={search.note ? 'hidden lg:block' : undefined}>
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              go(q.trim() ? { q: q.trim() } : { list: view, ...(tag ? { tag } : {}) });
            }}
          >
            <label htmlFor="notes-search" className="sr-only">
              {t('search')}
            </label>
            <Input id="notes-search" type="search" value={q} placeholder={t('search')} onChange={(e) => setQ(e.target.value)} />
          </form>
          {!search.q && (
            <Tabs value={view} onValueChange={(v) => go({ list: v as NoteListView, ...(tag ? { tag } : {}) })} className="mt-3">
              {/* Five lists wrap in the narrow column: the list grows with them (the variant's own h-8 would let the
                  second row cover the tag chips below). */}
              <TabsList className="flex flex-wrap group-data-horizontal/tabs:h-auto">
                {NOTE_LIST_VIEWS.map((v) => (
                  <TabsTrigger key={v} value={v}>
                    {t(`views.${v}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          {!search.q && (chips.length > 0 || tag) && (
            <div role="group" aria-label={t('tagFilter')} className="mt-3 flex flex-wrap gap-1">
              {(tag && !chips.some((c) => c.tag === tag) ? [{ tag, count: 0 }, ...chips] : chips).map((c) => (
                <Button
                  key={c.tag}
                  variant={c.tag === tag ? 'default' : 'outline'}
                  size="sm"
                  className="h-auto rounded-full px-2 py-0.5 text-xs"
                  aria-pressed={c.tag === tag}
                  onClick={() => go({ list: view, ...(c.tag === tag ? {} : { tag: c.tag }) })}
                >
                  {c.tag}
                </Button>
              ))}
            </div>
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
              <Empty title={search.q ? t('searchEmpty') : tag ? t('tagEmpty', { tag }) : t('emptyTitle')} hint={t('emptyScreenHint')} action={search.q || tag ? undefined : newButton} />
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
            <Editor key={open.data.id} note={open.data} slug={slug} role={role} back={back} focusTitle={created === open.data.id} onTag={(t) => go({ list: listOfNote(open.data, search.q ? undefined : search.list), tag: t })} />
          ) : (
            <ListSkeleton />
          )}
        </section>
      </div>
    </div>
  );
}
