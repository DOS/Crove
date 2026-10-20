// A post's due date in the browser's local time (#640), and when a post counts as overdue.

// Statuses after which a post no longer waits on anyone.
const SETTLED = ['published', 'partially_published', 'cancelled'];

// A post past its due date that has not gone out (or stopped).
export function isOverdue(post: { dueAt: string | null; status: string }, now: number): boolean {
  if (!post.dueAt || SETTLED.includes(post.status)) return false;
  const due = Date.parse(post.dueAt);
  return Number.isFinite(due) && due < now;
}

const pad = (n: number) => String(n).padStart(2, '0');

// An instant as a datetime-local input value, in the browser's zone; '' for none.
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A datetime-local input value (local time) as an instant; null when empty or not a date.
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
