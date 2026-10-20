// Putting a saved snippet into a text (#584).
// The text with the snippet put where the cursor was: on its own line when the cursor sits right after other text.
export function insertAt(text: string, start: number, end: number, snippet: string): { text: string; cursor: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === '' || /\s$/.test(before) ? '' : '\n';
  const trail = after === '' || /^\s/.test(after) ? '' : ' ';
  const next = `${before}${lead}${snippet}${trail}${after}`;
  return { text: next, cursor: before.length + lead.length + snippet.length };
}
