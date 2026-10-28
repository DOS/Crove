// The audit log screen's filter (#672): the form's text fields as the query's filter, and the cursor of the next page;
// and the commands' labels (#1654), on the screen and in the exported file.
import { AUDIT_OUTCOMES, type AuditCursor, type AuditFilter, type AuditOutcome, type AuditPage } from '@crove/kernel-contract';

export interface AuditFilterForm {
  actor: string;
  command: string;
  outcome: string;
  target: string;
  from: string;
  to: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Only what the server would accept: a target that is not a whole id is left out (the screen says so) rather than sent.
export function auditFilter(form: AuditFilterForm): AuditFilter {
  const target = form.target.trim().toLowerCase();
  return {
    ...(form.actor ? { actor: form.actor } : {}),
    ...(form.command ? { command: form.command } : {}),
    ...((AUDIT_OUTCOMES as readonly string[]).includes(form.outcome) ? { outcome: form.outcome as AuditOutcome } : {}),
    ...(UUID.test(target) ? { targetId: target } : {}),
    ...(DATE.test(form.from) ? { from: form.from } : {}),
    ...(DATE.test(form.to) ? { to: form.to } : {}),
  };
}

export function nextAuditCursor(page: AuditPage): AuditCursor | undefined {
  const last = page.items.at(-1);
  return page.more && last ? { at: last.at, id: last.id } : undefined;
}

// The catalogs' command labels (#1654): nested by the dotted parts of each command's name.
export interface CommandLabels {
  readonly [part: string]: string | CommandLabels;
}

// The label of a command or query, or null for a name with none (one no longer registered, say).
export function commandLabel(labels: CommandLabels, name: string): string | null {
  let node: string | CommandLabels | undefined = labels;
  for (const part of name.split('.')) {
    if (typeof node !== 'object' || !Object.hasOwn(node, part)) return null;
    node = node[part];
  }
  return typeof node === 'string' ? node : null;
}

// A cell as the server writes it (csvCell in packages/kernel/src/audit-log.ts): quoted when it holds a comma, quote or
// line break, and a leading =, +, - or @ taken as text.
function csvCell(value: string): string {
  const s = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The rows of a CSV file as the server writes it, each cell as written (quotes and all): a comma or a line break splits
// only outside quotes.
function csvRows(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') {
      row.push(body.slice(start, i));
      start = i + 1;
    } else if (!quoted && ch === '\r' && body[i + 1] === '\n') {
      row.push(body.slice(start, i));
      rows.push(row);
      row = [];
      start = i + 2;
      i++;
    }
  }
  if (start < body.length || row.length > 0) rows.push([...row, body.slice(start)]);
  return rows;
}

// The audit export (kernel.audit.export) with a command_label column after its command column, in the screen's
// language; every cell of the server's file stays as written. A file without a command column is returned unchanged.
export function withCommandLabels(csv: string, label: (command: string) => string | null): string {
  const bom = csv.startsWith('﻿') ? '﻿' : '';
  const rows = csvRows(csv.slice(bom.length));
  const at = rows[0]?.indexOf('command') ?? -1;
  if (at < 0) return csv;
  const lines = rows.map((cells, i) => {
    const command = cells[at] ?? '';
    const extra = i === 0 ? 'command_label' : csvCell(label(command.startsWith('"') ? command.slice(1, -1).replace(/""/g, '"') : command) ?? '');
    return [...cells.slice(0, at + 1), extra, ...cells.slice(at + 1)].join(',');
  });
  return `${bom}${lines.join('\r\n')}\r\n`;
}
