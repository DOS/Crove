// Formats a decimal string (e.g. "1980000.0000") as Vietnamese money without going through floats.
export function formatMoney(value: string | null | undefined, currency = 'VND'): string {
  if (value === null || value === undefined || value === '') return '';
  const negative = value.startsWith('-');
  const [intPart = '0', frac = ''] = (negative ? value.slice(1) : value).split('.');
  const grouped = BigInt(intPart || '0').toLocaleString('vi-VN');
  const fraction = frac.replace(/0+$/, '');
  const shown = currency === 'VND' ? grouped : `${grouped}${fraction ? `,${fraction.slice(0, 2)}` : ''}`;
  return `${negative ? '-' : ''}${shown}${currency === 'VND' ? ' ₫' : ` ${currency}`}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const [y, m, d] = value.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : value;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}
