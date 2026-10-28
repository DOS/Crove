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
const LIST = '- ';
const TASK = '- [ ] ';
// The list prefixes a line may carry already: a checklist step (done or not) or a list item.
const ANY_PREFIX = /^- \[[ xX]\] |^- /;

// The lines a selection touches: from the start of the first to the end of the last (a selection ending just after a
// line break does not touch the next line).
function lineSpan(value: string, start: number, end: number): [number, number] {
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const next = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
  return [from, next === -1 ? value.length : next];
}

// Each line becomes the given kind of item, whatever list prefix it had; when every line already is one, the prefix
// comes off (a toggle).
function prefixLines(edit: TextEdit, prefix: string): TextEdit {
  const [from, to] = lineSpan(edit.value, edit.start, edit.end);
  const lines = edit.value.slice(from, to).split('\n');
  const kindOf = (l: string) => (l.startsWith(TASK) || /^- \[[xX]\] /.test(l) ? TASK : l.startsWith(LIST) ? LIST : null);
  const all = lines.every((l) => kindOf(l) === prefix);
  const next = lines.map((l) => (all ? l.replace(ANY_PREFIX, '') : prefix + l.replace(ANY_PREFIX, ''))).join('\n');
  const value = edit.value.slice(0, from) + next + edit.value.slice(to);
  // A collapsed cursor stays at the same spot of its line's text; a selection covers the lines it touched.
  if (edit.start === edit.end) {
    const line = edit.value.slice(from, to).split('\n')[0] ?? '';
    const old = line.match(ANY_PREFIX)?.[0].length ?? 0;
    const added = all ? 0 : prefix.length;
    const at = from + added + Math.max(0, edit.start - from - old);
    return { value, start: at, end: at };
  }
  return { value, start: from, end: from + next.length };
}

export function applyFormat(edit: TextEdit, format: MarkdownFormat): TextEdit {
  const { value } = edit;
  if (format === 'list') return prefixLines(edit, LIST);
  if (format === 'task') return prefixLines(edit, TASK);
  // Spaces at the ends of the selection (a double-click takes the word's trailing space) stay outside the markers:
  // "**khách **" would not render as bold.
  let start = edit.start;
  let end = edit.end;
  while (start < end && /\s/.test(value[start] ?? '')) start += 1;
  while (end > start && /\s/.test(value[end - 1] ?? '')) end -= 1;
  const selected = value.slice(start, end);
  if (format === 'bold') {
    // Unwraps bold around the selection, or a selection that includes its own stars.
    if (start >= 2 && value.slice(start - 2, start) === '**' && value.slice(end, end + 2) === '**') {
      return { value: value.slice(0, start - 2) + selected + value.slice(end + 2), start: start - 2, end: end - 2 };
    }
    if (selected.length >= 4 && selected.startsWith('**') && selected.endsWith('**')) {
      return { value: value.slice(0, start) + selected.slice(2, -2) + value.slice(end), start, end: end - 4 };
    }
    return { value: `${value.slice(0, start)}**${selected}**${value.slice(end)}`, start: start + 2, end: end + 2 };
  }
  // A link: the selection becomes its text and the address is selected, ready to be typed over; with nothing
  // selected, the cursor goes between the brackets.
  const text = `[${selected}](${LINK_URL})`;
  const out = value.slice(0, start) + text + value.slice(end);
  if (selected === '') return { value: out, start: start + 1, end: start + 1 };
  const urlAt = start + selected.length + 3;
  return { value: out, start: urlAt, end: urlAt + LINK_URL.length };
}

// The shortcut of a key press in the editor, or null: Ctrl or Cmd with B (bold), K (link), Shift+8 (list) and
// Shift+9 (checklist), as in the common document editors. The physical key counts first, so the shortcuts work on any
// keyboard layout; a key held down or a character being composed (Vietnamese Telex) is not a shortcut.
export function shortcutFormat(e: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}): MarkdownFormat | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.repeat || e.isComposing) return null;
  const key = e.key.toLowerCase();
  if (!e.shiftKey && (e.code === 'KeyB' || key === 'b')) return 'bold';
  if (!e.shiftKey && (e.code === 'KeyK' || key === 'k')) return 'link';
  if (e.shiftKey && (e.code === 'Digit8' || key === '8' || key === '*')) return 'list';
  if (e.shiftKey && (e.code === 'Digit9' || key === '9' || key === '(')) return 'task';
  return null;
}
