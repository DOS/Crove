// @mentions in internal post comments (#793). A comment stores a mention as <@user-id>, so a renamed member stays
// mentioned and a name never has to be parsed; the app shows it as @name and the server notifies the member.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const MENTION_PATTERN = new RegExp(`<@(${UUID})>`, 'g');
// Members one comment may mention; more are kept as text but notify nobody.
export const MENTIONS_MAX = 20;

export const mentionToken = (userId: string) => `<@${userId}>`;

// The members a comment mentions, in order, each once.
export function mentionsOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_PATTERN)) {
    const id = m[1] as string;
    if (!out.includes(id)) out.push(id);
    if (out.length === MENTIONS_MAX) break;
  }
  return out;
}

// The comment as text and mentions, for showing it.
export type CommentPart = { text: string } | { mention: string };
export function commentParts(body: string): CommentPart[] {
  const parts: CommentPart[] = [];
  let at = 0;
  for (const m of body.matchAll(MENTION_PATTERN)) {
    const start = m.index ?? 0;
    if (start > at) parts.push({ text: body.slice(at, start) });
    parts.push({ mention: m[1] as string });
    at = start + m[0].length;
  }
  if (at < body.length) parts.push({ text: body.slice(at) });
  return parts;
}

// What the comment box shows: each mention as @name, with the names it picked, so the text can be stored again.
export function mentionsForEditing(body: string, nameOf: (userId: string) => string | null): { text: string; picked: Array<[string, string]> } {
  const picked: Array<[string, string]> = [];
  const text = commentParts(body)
    .map((p) => {
      if ('text' in p) return p.text;
      const name = nameOf(p.mention);
      if (!name) return mentionToken(p.mention);
      if (!picked.some(([label]) => label === name)) picked.push([name, p.mention]);
      return `@${name}`;
    })
    .join('');
  return { text, picked };
}

// The text to store: each @name the person picked from the list becomes its member's token. Longer names first, so
// "@Lan Anh" is not taken as "@Lan" followed by text.
export function mentionsForStoring(text: string, picked: ReadonlyArray<readonly [string, string]>): string {
  let out = text;
  for (const [label, userId] of [...picked].sort((a, b) => b[0].length - a[0].length)) {
    // Only a whole @name: not inside an address (a@Lan), nor the start of a longer word (@Lanh).
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_.@])@${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), mentionToken(userId));
  }
  return out;
}

// How the comment box names each member: the name, or the name and email where two members share one, so picking
// either always stores the right person.
export function mentionLabels(members: ReadonlyArray<{ userId: string; name: string; email: string }>): Map<string, string> {
  const count = new Map<string, number>();
  for (const m of members) count.set(m.name, (count.get(m.name) ?? 0) + 1);
  return new Map(members.map((m) => [m.userId, (count.get(m.name) ?? 0) > 1 && m.name !== m.email ? `${m.name} (${m.email})` : m.name]));
}

// The @query being typed at the caret, for the member list: from an @ that starts a word up to the caret.
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1] as string))) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@<>]/.test(query) || /\s{2}/.test(query)) return null;
  return { start: at, query };
}
