// Drafts from library files (#1080): the files picked in the library, in the order they were picked, and the request
// the "Create drafts" panel sends. The server checks every file against every channel and saves all or none.
import { SOCIAL_DRAFTS_FROM_MEDIA_MAX } from '@crove/kernel-contract';

export const DRAFTS_FROM_MEDIA_MAX = SOCIAL_DRAFTS_FROM_MEDIA_MAX;

export type CaptionKind = 'none' | 'filename' | 'snippet';

// Picks or unpicks a file; a new pick goes last, and none past the cap.
export function togglePick(picked: readonly string[], fileId: string, max = DRAFTS_FROM_MEDIA_MAX): string[] {
  if (picked.includes(fileId)) return picked.filter((id) => id !== fileId);
  return picked.length >= max ? [...picked] : [...picked, fileId];
}

export interface DraftsForm {
  fileIds: readonly string[];
  connectionIds: readonly string[];
  caption: CaptionKind;
  snippetId: string | null;
  queue: boolean;
}

// The request, or null while it is not complete: a file, a channel, and a snippet when the caption is one.
export function draftsRequest(form: DraftsForm) {
  if (form.fileIds.length === 0 || form.fileIds.length > DRAFTS_FROM_MEDIA_MAX || form.connectionIds.length === 0) return null;
  if (form.caption === 'snippet' && !form.snippetId) return null;
  const caption = form.caption === 'snippet' ? { kind: 'snippet' as const, snippetId: form.snippetId as string } : { kind: form.caption };
  return { fileIds: [...form.fileIds], connectionIds: [...form.connectionIds], caption, ...(form.queue ? { queue: true } : {}) };
}

// The index after "media." on an issue, counted from 1 for the person (always 1 here: one file per draft).
export const mediaNumber = (field: string) => Number(field.split('.')[1] ?? 0) + 1;
