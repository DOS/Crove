// A CSV cell as a spreadsheet reads it, for every Social export (metrics #578, content plan #978, team report #1058):
// quoted when it holds a comma, quote or line break, and a leading =, +, -, @, tab or carriage return (which a
// spreadsheet would run as a formula) taken as text. Isomorphic, so the app writes a file it builds with the same rule.
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
