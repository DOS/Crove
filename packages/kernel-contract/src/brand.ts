// The product name users see (BRAND_NAME, issues #1040 and #1045) as the prefix of a downloaded file's name: lower
// case ASCII letters and digits joined by dashes, so "Tên Mới" names files "ten-moi-...". "Crove" gives "crove", the
// prefix of before; a name with nothing left (only punctuation) falls back to it too.
export function brandSlug(brand: string): string {
  const slug = brand
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'crove';
}
