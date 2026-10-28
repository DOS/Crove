// The notes editor's toolbar and tag filter (issue #1739): Markdown inserted at the cursor with the selection where a
// member expects it, the shortcuts, the tag chips' order, and ?tag= in the address.
import { describe, expect, it } from 'vitest';
import { applyFormat, shortcutFormat, type TextEdit } from '../src/lib/markdown-edit.ts';
import { parseNotesSearch, tagCounts } from '../src/lib/notes.ts';

// The text with ‹ and › marking the selection, and back (Markdown uses [ and ] itself).
function marked(text: string): TextEdit {
  const start = text.indexOf('‹');
  const end = text.indexOf('›') - 1;
  return { value: text.replace('‹', '').replace('›', ''), start, end };
}
const show = (e: TextEdit) => `${e.value.slice(0, e.start)}‹${e.value.slice(e.start, e.end)}›${e.value.slice(e.end)}`;
const apply = (text: string, format: Parameters<typeof applyFormat>[1]) => show(applyFormat(marked(text), format));

describe('note toolbar (#1739)', () => {
  it('wraps the selection in bold, and unwraps it again', () => {
    expect(apply('Gọi ‹khách› trước 15h', 'bold')).toBe('Gọi **‹khách›** trước 15h');
    expect(apply('Gọi **‹khách›** trước 15h', 'bold')).toBe('Gọi ‹khách› trước 15h');
    // Nothing selected: the cursor lands between the stars.
    expect(apply('Gọi ‹›', 'bold')).toBe('Gọi **‹›**');
  });

  it('makes the touched lines a list or a checklist, and back', () => {
    expect(apply('một\nh‹ai\nba›\nbốn', 'list')).toBe('một\n‹- hai\n- ba›\nbốn');
    expect(apply('‹- hai\n- ba›', 'list')).toBe('‹hai\nba›');
    // A collapsed cursor stays at its spot in the line.
    expect(apply('Gọi kh‹›ách', 'task')).toBe('- [ ] Gọi kh‹›ách');
    expect(apply('- [ ] Gọi kh‹›ách', 'task')).toBe('Gọi kh‹›ách');
  });

  it('turns the selection into a link with its address selected, or puts the cursor in empty brackets', () => {
    expect(apply('Xem ‹cổng thuế› nhé', 'link')).toBe('Xem [cổng thuế](‹https://›) nhé');
    expect(apply('Xem ‹› nhé', 'link')).toBe('Xem [‹›](https://) nhé');
  });

  it('reads the shortcuts with Ctrl or Cmd, and nothing else', () => {
    const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; code: string }> = {}) =>
      shortcutFormat({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
    expect(key('b', { ctrlKey: true })).toBe('bold');
    expect(key('B', { metaKey: true })).toBe('bold');
    expect(key('k', { ctrlKey: true })).toBe('link');
    expect(key('*', { ctrlKey: true, shiftKey: true, code: 'Digit8' })).toBe('list');
    expect(key('(', { metaKey: true, shiftKey: true, code: 'Digit9' })).toBe('task');
    expect(key('b')).toBeNull();
    expect(key('b', { ctrlKey: true, altKey: true })).toBeNull();
    expect(key('x', { ctrlKey: true })).toBeNull();
  });
});

describe('note tag filter (#1739)', () => {
  it('orders the chips by use, then by name, up to a limit', () => {
    const notes = [{ tags: ['thuế', 'ngân hàng'] }, { tags: ['thuế'] }, { tags: ['bảo hiểm'] }, { tags: [] }];
    expect(tagCounts(notes)).toEqual([
      { tag: 'thuế', count: 2 },
      { tag: 'bảo hiểm', count: 1 },
      { tag: 'ngân hàng', count: 1 },
    ]);
    expect(tagCounts(notes, 1)).toEqual([{ tag: 'thuế', count: 2 }]);
  });

  it('keeps ?tag= as the server keeps a tag, and drops an empty one', () => {
    expect(parseNotesSearch({ list: 'shared', tag: ' Ngân Hàng ' })).toEqual({ list: 'shared', tag: 'ngân hàng' });
    expect(parseNotesSearch({ tag: ' , ' })).toEqual({});
    expect(parseNotesSearch({ tag: 'x'.repeat(60) })).toEqual({ tag: 'x'.repeat(40) });
  });
});
