// A member's own notes and to-dos as a file for their download (#1678, notes.md section 5 "Tải về"): Markdown to read,
// JSON to move them elsewhere. Built in the browser from notes.mine.export; no React imports, so it is unit tested.
import type { NotesExport } from '@crove/kernel-contract';

export interface NotesExportWords {
  heading: string;
  exportedAt: string;
  notes: string;
  todos: string;
  private: string;
  shared: string;
  tags: string;
  pinned: string;
  archived: string;
  trashed: string;
  created: string;
  updated: string;
  links: string;
  status: Record<NotesExport['todos'][number]['status'], string>;
  due: string;
  remind: string;
  done: string;
  truncated: string;
}

const line = (label: string, value: string) => `- ${label}: ${value}`;

/** The Markdown file: each note under its title with its facts, then its body as written; each to-do with its steps. */
export function notesMarkdown(data: NotesExport, w: NotesExportWords): string {
  const out: string[] = [`# ${w.heading}`, '', line(w.exportedAt, data.exportedAt)];
  if (data.truncated) out.push('', `> ${w.truncated}`);
  out.push('', `## ${w.notes} (${data.notes.length})`);
  for (const n of data.notes) {
    out.push('', `### ${n.title}`, '', line(n.visibility === 'org' ? w.shared : w.private, n.id));
    if (n.tags.length > 0) out.push(line(w.tags, n.tags.join(', ')));
    if (n.pinned) out.push(`- ${w.pinned}`);
    if (n.archivedAt) out.push(line(w.archived, n.archivedAt));
    if (n.deletedAt) out.push(line(w.trashed, n.deletedAt));
    out.push(line(w.created, n.createdAt), line(w.updated, n.updatedAt));
    if (n.links.length > 0) out.push(line(w.links, n.links.map((l) => `${l.targetType} ${l.targetId}`).join(', ')));
    if (n.body.trim()) out.push('', n.body.trimEnd());
  }
  out.push('', `## ${w.todos} (${data.todos.length})`);
  for (const t of data.todos) {
    out.push('', `### [${t.status === 'done' ? 'x' : ' '}] ${t.title}`, '', line(w.status[t.status], t.id));
    if (t.dueAt) out.push(line(w.due, `${t.dueAt} (${t.timeZone})`));
    else if (t.dueOn) out.push(line(w.due, t.dueOn));
    if (t.remindAt) out.push(line(w.remind, t.remindAt));
    if (t.doneAt) out.push(line(w.done, t.doneAt));
    if (t.deletedAt) out.push(line(w.trashed, t.deletedAt));
    out.push(line(w.created, t.createdAt), line(w.updated, t.updatedAt));
    if (t.details.trim()) out.push('', t.details.trimEnd());
    if (t.checklist.length > 0) out.push('', ...t.checklist.map((s) => `- [${s.done ? 'x' : ' '}] ${s.text}`));
  }
  return `${out.join('\n')}\n`;
}

/** Saves text as a file through a link the browser clicks. */
export function saveText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Some browsers still read the link a moment after the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
