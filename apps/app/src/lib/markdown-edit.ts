// The note editor's toolbar (issue #1739, notes plan §3.10): bold, a list, a checklist step and a link, inserted as
// Markdown at the cursor. Pure: each takes the text and the selection and answers the new text and selection, so the
// textarea keeps the cursor where the member expects it.
export type MarkdownFormat = 'bold' | 'list' | 'task' | 'link';

export interface TextEdit {
  value: string;
  start: number;
  end: number;
}

const LINK_URL = 'https://';

// The lines a selection touches: from the start of the first to the end of the last.
function lineSpan(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const next = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
  return [from, next === -1 ? value.length : next];
}

// Each line starts with the prefix; when every line already does, the prefix comes off again (a toggle).
function prefixLines(edit: TextEdit, prefix: string): TextEdit {
  const [from, to] = lineSpan(edit.value, edit.start, edit.end);
  const lines = edit.value.slice(from, to).split('\n');
  const all = lines.every((l) => l.startsWith(prefix));
  const next = lines.map((l) => (all ? l.slice(prefix.length) : l.startsWith(prefix) ? l : prefix + l)).join('\n');
  const value = edit.value.slice(0, from) + next + edit.value.slice(to);
  // A collapsed cursor stays at the same spot of its line; a selection covers the lines it touched.
  if (edit.start === edit.end) {
    const shift = all ? -prefix.length : prefix.length;
    const at = Math.max(from, edit.start + shift);
    return { value, start: at, end: at };
  }
  return { value, start: from, end: from + next.length };
}

export function applyFormat(edit: TextEdit, format: MarkdownFormat): TextEdit {
  const { value, start, end } = edit;
  const selected = value.slice(start, end);
  if (format === 'bold') {
    // Unwraps a selection already in **...**.
    if (value.slice(start - 2, start) === '**' && value.slice(end, end + 2) === '**') {
      return { value: value.slice(0, start - 2) + selected + value.slice(end + 2), start: start - 2, end: end - 2 };
    }
    return { value: `${value.slice(0, start)}**${selected}**${value.slice(end)}`, start: start + 2, end: end + 2 };
  }
  if (format === 'list') return prefixLines(edit, '- ');
  if (format === 'task') return prefixLines(edit, '- [ ] ');
  // A link: the selection becomes its text and the address is selected, ready to be typed over; with nothing
  // selected, the cursor goes between the brackets.
  const text = `[${selected}](${LINK_URL})`;
  const out = value.slice(0, start) + text + value.slice(end);
  if (selected === '') return { value: out, start: start + 1, end: start + 1 };
  const urlAt = start + selected.length + 3;
  return { value: out, start: urlAt, end: urlAt + LINK_URL.length };
}

// The shortcut of a key press in the editor, or null: Ctrl or Cmd with B (bold), K (link), Shift+8 (list) and
// Shift+9 (checklist), as in the common document editors.
export function shortcutFormat(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): MarkdownFormat | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (!e.shiftKey && key === 'b') return 'bold';
  if (!e.shiftKey && key === 'k') return 'link';
  if (e.shiftKey && (e.code === 'Digit8' || key === '8' || key === '*')) return 'list';
  if (e.shiftKey && (e.code === 'Digit9' || key === '9' || key === '(')) return 'task';
  return null;
}
