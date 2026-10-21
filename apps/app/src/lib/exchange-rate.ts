// The exchange rate an accountant types for a foreign-currency invoice (#918), as the decimal string the kernel takes
// (VND per unit, at most 10 decimals), or null when it cannot be read. Vietnamese writes 25.450 or 25,450 for
// twenty-five thousand four hundred and fifty, so groups of exactly three digits after a separator are thousands;
// otherwise one separator, dot or comma, starts the decimals (25450,5 or 25450.5). Anything else is refused rather
// than guessed, and the screen shows the rate it read before it is saved.
export function parseExchangeRate(text: string): string | null {
  const value = text.replace(/\s/g, '');
  let plain: string;
  if (/^\d{1,3}([.,]\d{3})+$/.test(value) && new Set(value.replace(/\d/g, '')).size === 1) plain = value.replace(/[.,]/g, '');
  else if (/^\d{1,3}(\.\d{3})+,\d{1,10}$/.test(value)) plain = value.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+\.\d{1,10}$/.test(value)) plain = value.replace(/,/g, '');
  else if (/^\d+([.,]\d{1,10})?$/.test(value)) plain = value.replace(',', '.');
  else return null;
  const [whole = '', fraction = ''] = plain.split('.');
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  const trimmedFraction = fraction.replace(/0+$/, '');
  if (trimmedWhole.length > 13 || !/[1-9]/.test(trimmedWhole + trimmedFraction)) return null;
  return trimmedFraction ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole;
}
