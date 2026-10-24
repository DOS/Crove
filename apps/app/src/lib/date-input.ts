// What a date field shows and reads (#1304): dd/mm/yyyy and mm/yyyy whatever the browser's language (DESIGN.md §5.5),
// while its value stays ISO (yyyy-mm-dd, yyyy-mm) as with the native inputs. A native date input shows the browser's
// own format, so with Chrome in English "10/09/2026" is 9 October to the reader and 10 September to everyone else.

export type DateKind = 'day' | 'month';

const DAY_TYPED = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const DAY_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_TYPED = /^(\d{1,2})[/.-](\d{4})$/;
const MONTH_ISO = /^(\d{4})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, '0');

function isoDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null;
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day > last ? null : `${year}-${pad(month)}-${pad(day)}`;
}

// The ISO value of what was typed, or null when it is not a whole, real date: 31/02/2026, 13/2026 and 1/1 are null.
export function parseDateText(text: string, kind: DateKind): string | null {
  const s = text.trim();
  if (kind === 'day') {
    const typed = DAY_TYPED.exec(s);
    if (typed) return isoDay(Number(typed[3]), Number(typed[2]), Number(typed[1]));
    const iso = DAY_ISO.exec(s);
    return iso ? isoDay(Number(iso[1]), Number(iso[2]), Number(iso[3])) : null;
  }
  const typed = MONTH_TYPED.exec(s);
  const iso = typed ? null : MONTH_ISO.exec(s);
  if (!typed && !iso) return null;
  const year = Number(typed ? typed[2] : iso?.[1]);
  const month = Number(typed ? typed[1] : iso?.[2]);
  return month >= 1 && month <= 12 ? `${year}-${pad(month)}` : null;
}

// How an ISO value reads in the field: "05/09/2026" or "09/2026"; "" for no value or one that is not ISO.
export function formatDateValue(value: string, kind: DateKind): string {
  if (kind === 'day') {
    const iso = DAY_ISO.exec(value);
    return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : '';
  }
  const iso = MONTH_ISO.exec(value);
  return iso ? `${iso[2]}/${iso[1]}` : '';
}
