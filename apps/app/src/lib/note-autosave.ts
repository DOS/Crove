// The note editor's autosave (issue #1671, notes plan §3.10): the author's edits save a pause after the last keystroke,
// against the revision the editor holds. One save at a time: edits made while a save is out go in the next one, and the
// text counts as saved only when no edit came after the save started. A conflict (the note changed elsewhere) stops
// autosaving until the editor takes the server's copy (reset). Leaving the note saves what is pending (flush).
export interface NoteValues {
  title: string;
  body: string;
  tags: string;
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

export interface AutosaverOptions {
  revision: number;
  delayMs: number;
  // Saves the values against the revision and answers the new one.
  save: (revision: number, values: NoteValues) => Promise<number>;
  isConflict: (error: unknown) => boolean;
  onState: (state: SaveState, error?: unknown) => void;
}

export interface Autosaver {
  edit(values: NoteValues): void;
  flush(): Promise<void>;
  // Edits not saved yet.
  dirty(): boolean;
  // A save is out.
  busy(): boolean;
  revision(): number;
  // Another write (making the note shared) moved the revision on.
  setRevision(revision: number): void;
  // The editor took the server's copy: nothing pending, no conflict, its revision.
  reset(revision: number): void;
  dispose(): void;
}

export function createAutosaver(options: AutosaverOptions): Autosaver {
  let revision = options.revision;
  let values: NoteValues | null = null;
  // Each edit's number, and the number of the last edit a save carried.
  let edits = 0;
  let saved = 0;
  let inFlight = false;
  let again = false;
  let conflict = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const dirty = () => edits !== saved;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), options.delayMs);
  };

  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty() || conflict || values === null || values.title.trim() === '') return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const carried = edits;
    options.onState('saving');
    try {
      revision = await options.save(revision, values);
      saved = carried;
      inFlight = false;
      if (!dirty()) {
        options.onState('saved');
      } else if (again) {
        again = false;
        await flush();
      } else {
        options.onState('idle');
        schedule();
      }
    } catch (error) {
      inFlight = false;
      again = false;
      if (options.isConflict(error)) conflict = true;
      options.onState(conflict ? 'conflict' : 'error', error);
    }
  }

  return {
    edit(next) {
      values = next;
      edits += 1;
      if (conflict) return;
      options.onState('idle');
      schedule();
    },
    flush,
    dirty,
    busy: () => inFlight,
    revision: () => revision,
    setRevision(next) {
      revision = next;
    },
    reset(next) {
      clearTimeout(timer);
      revision = next;
      values = null;
      saved = edits;
      again = false;
      conflict = false;
      options.onState('idle');
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
