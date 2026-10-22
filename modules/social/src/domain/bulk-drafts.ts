// One draft per library file (#1080): the caption a file's name gives, and which of a channel's issues are about the
// file itself. Pure, so the app and the command agree.
import type { Issue } from './validate.ts';

// A file's name as a caption: without its folder or extension, underscores read as spaces, runs of spaces as one.
export function captionFromFilename(filename: string): string {
  const name = filename.replace(/^.*[\\/]/, '').normalize('NFC');
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return (stem.trim() === '' ? name : stem).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The issues of a draft that are about its file: kind, type, size, shape or length. Text, title and settings are the
// writer's to finish in the draft, as in any draft, and are checked when it goes to review.
export const fileIssues = (issues: readonly Issue[]): Issue[] => issues.filter((i) => i.field === 'media' || i.field.startsWith('media.'));
