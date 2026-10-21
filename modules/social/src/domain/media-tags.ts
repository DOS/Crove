// Tags on media library files (issue #904), the part the app shares with the commands: how a typed tag is normalized
// and when two tags are the same. The database holds the final word (a unique index on lower(tag) per file).

export const MEDIA_TAG_MAX_LENGTH = 40;
export const MAX_TAGS_PER_FILE = 20;

// NFC, so a tag typed with combining marks matches the same tag typed precomposed; every run of white space (tabs,
// line breaks, non-breaking spaces) becomes one space, and none is left at either end. Case is kept.
export function normalizeMediaTag(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

// The key two tags are compared by: the same tag whatever its case.
export const mediaTagKey = (tag: string) => normalizeMediaTag(tag).toLowerCase();

// Control characters other than white space have no place in a tag, nor invisible format characters (zero-width
// spaces and joiners, direction marks and overrides): two tags that look alike must be the same tag.
const CONTROL = /[\p{Cc}\p{Cf}]/u;

// Why a normalized tag is refused, or null when it is fine.
export function mediaTagProblem(tag: string): 'empty' | 'too_long' | 'control' | null {
  if (tag.length === 0) return 'empty';
  if ([...tag].length > MEDIA_TAG_MAX_LENGTH) return 'too_long';
  if (CONTROL.test(tag)) return 'control';
  return null;
}

// Tags as typed, normalized, the empty ones dropped and each tag once (its first spelling kept), in the order given.
export function normalizeMediaTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const tag = normalizeMediaTag(r);
    const key = tag.toLowerCase();
    if (tag.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

// What a member types in the tag box: tags separated by commas.
export const splitMediaTags = (typed: string) => normalizeMediaTags(typed.split(','));
