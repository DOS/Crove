import { zSlug } from '@crove/kernel-contract';

/** Marks where the org slug goes in an attachment filename. */
export const ORG_SLUG = Symbol('org-slug');

// A filename segment other than the slug (a report period, an export part, an extension): ASCII letters, digits, ".",
// "_" and "-" only, so nothing that could break out of a quoted header value can get in.
const SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;
const EXTENSION = /^[a-z0-9]{1,8}$/;

/**
 * The Content-Disposition header of an export download, built from an org slug and a fixed filename pattern.
 * The slug must be a valid org slug and every other segment plain ASCII, or this throws: a quote, CR, LF or
 * non-ASCII character can never reach the header. The result carries both RFC 6266 forms (`filename` and `filename*`).
 */
export function attachmentDisposition(slug: string | null, parts: ReadonlyArray<string | typeof ORG_SLUG>, extension: string): string {
  const checkedSlug = zSlug.safeParse(slug);
  if (!checkedSlug.success) throw new Error('attachment filename needs a valid org slug');
  if (!EXTENSION.test(extension)) throw new Error('attachment filename has an invalid extension');
  const segments = parts.map((part) => {
    if (part === ORG_SLUG) return checkedSlug.data;
    if (!SEGMENT.test(part)) throw new Error('attachment filename has an invalid segment');
    return part;
  });
  const filename = `${segments.join('-')}.${extension}`;
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
