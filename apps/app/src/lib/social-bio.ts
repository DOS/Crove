// The org's link-in-bio page (#707): its public address, and a first slug made from the org's name.
export const bioUrl = (slug: string) => `${typeof location === 'undefined' ? '' : location.origin}/b/${slug}`;

// The org's name as a slug: Vietnamese marks dropped (đ as d), lower case, letters and digits joined by single
// hyphens, 3 to 40 characters.
export function slugFrom(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return base.length >= 3 ? base : `${base || 'trang'}-bio`.slice(0, 40);
}
