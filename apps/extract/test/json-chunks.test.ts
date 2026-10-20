// The parser process writes its answer in pieces (#653); joined, they must be the very text JSON.stringify gives.
import { describe, expect, it } from 'vitest';
import { jsonChunks } from '../src/json-chunks.ts';

const joined = (value: unknown, pieceChars?: number) => [...jsonChunks(value, pieceChars)].join('');

describe('jsonChunks', () => {
  it.each([
    ['an answer with nested entries', { ok: true, kind: 'zip', archive: { entries: [{ name: 'hd "1".xml', sizeBytes: 3, content: 'YWJj', rejected: null }] } }],
    ['a failure', { ok: false, code: 'memory', message: 'Tệp quá lớn\n' }],
    ['optional fields left undefined', { a: undefined, b: 1, c: [undefined, 2], d: { e: undefined } }],
    ['empty containers and numbers', { a: [], b: {}, c: -0.5, d: 1e21, e: Number.NaN, f: false }],
    ['a top-level primitive', 'x'],
    ['a top-level array', [1, 'two', null, [3]]],
  ])('gives the text of JSON.stringify for %s', (_, value) => {
    expect(joined(value)).toBe(JSON.stringify(value));
    expect(joined(value, 1)).toBe(JSON.stringify(value));
  });

  it('cuts a large answer into pieces near the piece size, without splitting a value', () => {
    const value = { entries: Array.from({ length: 50 }, (_, i) => ({ name: `hd-${i}.xml`, content: 'A'.repeat(1000) })) };
    const pieces = [...jsonChunks(value, 4096)];
    expect(pieces.length).toBeGreaterThan(10);
    expect(pieces.slice(0, -1).every((p) => p.length >= 4096 && p.length < 4096 + 1100)).toBe(true);
    expect(pieces.join('')).toBe(JSON.stringify(value));
  });
});
