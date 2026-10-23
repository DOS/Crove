// The review checklist (#1105) on the client: the settings draft's checks and the review panel's ticks.
import { describe, expect, it } from 'vitest';
import { needsChecklist } from '../src/lib/social-board.ts';
import { checklistItems, checksFor, draftInput, draftOf, draftProblem, fullyTicked, labelLength, moveItem, normalizeLabel, sameAsSaved, type CheckItem } from '../src/lib/social-review-checklist.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const item = (id: string, position: number, connectionId: string | null, label = `Mục ${position}`): CheckItem => ({ id, position, connectionId, label });

describe('the checklist draft', () => {
  it('normalizes labels as the command does and counts characters, not UTF-16 units', () => {
    expect(normalizeLabel('  Soát   chính\ttả \n')).toBe('Soát chính tả');
    expect(normalizeLabel('Đà')).toBe('Đà');
    expect(labelLength('😀'.repeat(120))).toBe(120);
  });

  it('refuses empty, too long, duplicate and too many items', () => {
    expect(draftProblem([])).toBeNull();
    expect(draftProblem([{ key: 'a', connectionId: null, label: '  ' }])).toBe('empty');
    expect(draftProblem([{ key: 'a', connectionId: null, label: 'x'.repeat(121) }])).toBe('tooLong');
    expect(draftProblem([{ key: 'a', connectionId: null, label: 'x'.repeat(120) }])).toBeNull();
    expect(
      draftProblem([
        { key: 'a', connectionId: null, label: 'Link' },
        { key: 'b', connectionId: null, label: ' Link ' },
      ]),
    ).toBe('duplicate');
    // The same label for every channel and for one channel are two items.
    expect(
      draftProblem([
        { key: 'a', connectionId: null, label: 'Link' },
        { key: 'b', connectionId: A, label: 'Link' },
      ]),
    ).toBeNull();
    expect(draftProblem(Array.from({ length: 11 }, (_, i) => ({ key: String(i), connectionId: i % 2 ? A : null, label: `Mục ${i}` })))).toBe('tooMany');
  });

  it('sends normalized labels in order and compares with the saved list', () => {
    const saved = [item('c1', 0, null, 'Chính tả'), item('c2', 1, A, 'Liên kết')];
    const draft = draftOf(saved);
    expect(sameAsSaved(draft, saved)).toBe(true);
    expect(sameAsSaved(moveItem(draft, 1, -1), saved)).toBe(false);
    expect(draftInput([{ key: 'x', connectionId: A, label: '  Liên   kết ' }])).toEqual({ items: [{ connectionId: A, label: 'Liên kết' }] });
    expect(moveItem(draft, 0, -1)).toEqual(draft);
    expect(moveItem(draft, 0, 1).map((d) => d.key)).toEqual(['c2', 'c1']);
  });
});

describe('the review panel ticks', () => {
  const orgWide = item('c1', 0, null);
  const onA = item('c2', 1, A);
  const onB = item('c3', 2, B);
  const va = { connectionId: A, checklist: [orgWide, onA] };
  const vb = { connectionId: B, checklist: [orgWide, onB] };

  it('lists every item once, in order', () => {
    expect(checklistItems([vb, va]).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(checklistItems([{ checklist: [] }])).toEqual([]);
  });

  it('sends each channel the ticks of its own list and approves only when all are ticked', () => {
    const ticked = new Set(['c1', 'c2']);
    expect(checksFor(va, ticked)).toEqual(['c1', 'c2']);
    expect(checksFor(vb, ticked)).toEqual(['c1']);
    expect(fullyTicked([va], ticked)).toBe(true);
    expect(fullyTicked([va, vb], ticked)).toBe(false);
    expect(fullyTicked([va, vb], new Set(['c1', 'c2', 'c3']))).toBe(true);
    // No checklist: nothing to tick.
    expect(fullyTicked([{ checklist: [] }], new Set())).toBe(true);
  });

  it('keeps the board from approving a post whose channel in review has a checklist', () => {
    const v = (status: string, checklist: CheckItem[] = []) => ({ id: 'v', status, revision: 1, contentHash: 'h', checklist });
    const post = (variants: ReturnType<typeof v>[]) => ({ id: 'p', scheduledAt: null, variants });
    expect(needsChecklist(post([v('in_review')]))).toBe(false);
    expect(needsChecklist(post([v('in_review', [orgWide])]))).toBe(true);
    expect(needsChecklist(post([v('approved', [orgWide])]))).toBe(false);
  });
});
