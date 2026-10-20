// A video's cover (#642), as the variant's settings carry it (`settings.cover`): a frame of the video, at a time in
// milliseconds, or an image of the org, by file. The Social module checks the shape and the file when the variant is
// written, and which channels take which kind; each adapter sends what its platform takes and refuses the rest with
// COVER_NOT_SUPPORTED before anything is posted. The image's bytes and URL come through `readMedia` and `mediaUrl`,
// like the post's media.
export type VideoCover = { atMs: number } | { fileId: string };

export function videoCoverOf(settings: Readonly<Record<string, unknown>> | undefined): VideoCover | null {
  const value = settings?.cover;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { atMs, fileId } = value as Record<string, unknown>;
  if (typeof atMs === 'number' && Number.isSafeInteger(atMs) && atMs >= 0 && fileId === undefined) return { atMs };
  if (typeof fileId === 'string' && fileId !== '' && atMs === undefined) return { fileId };
  return null;
}

// The type of a cover image from its first bytes (YouTube's thumbnail upload names it); JPEG when it is not a PNG.
export function coverImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return png.every((b, i) => bytes[i] === b) ? 'image/png' : 'image/jpeg';
}
