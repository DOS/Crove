// The `usage-report` image role (issue #311, backlog review 2026-10-17 section 3): prints the weekly usage counts of
// the MVP goal from crove_kernel.usage_weekly(), read as crove_reporter. Deployment-wide and for the operator only:
// counts per ISO week, and per org (id and name) with --by-org. No tenant content. Runs once and exits.
//
//   usage-report [--weeks <1-104>] [--by-org] [--csv] [--time-zone <IANA name>]
//
// Exit codes: 0 printed, 2 the report could not run (configuration, connection, permissions).
import pg from 'pg';

export const USAGE_EXIT = { ok: 0, failed: 2 } as const;

export interface UsageArgs {
  weeks: number;
  byOrg: boolean;
  csv: boolean;
  timeZone: string;
}

/** One row of crove_kernel.usage_weekly(). org_id and org_name are null on the deployment row of a week. */
export interface UsageRow {
  week_start: string;
  iso_week: string;
  org_id: string | null;
  org_name: string | null;
  active_orgs: number;
  active_users: number;
  documents_uploaded: number;
  documents_emailed: number;
  proposals_approved: number;
  approved_without_edits: number;
  proposals_rejected: number;
  median_upload_to_approval_seconds: number | null;
  journal_exports: number;
  org_exports: number;
}

export const DEFAULT_USAGE_ARGS: UsageArgs = { weeks: 8, byOrg: false, csv: false, timeZone: 'Asia/Ho_Chi_Minh' };

export function parseUsageArgs(argv: readonly string[]): UsageArgs {
  const args: UsageArgs = { ...DEFAULT_USAGE_ARGS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm usage:report -- --weeks 4` passes the separator on.
    if (arg === '--') continue;
    if (arg === '--by-org') args.byOrg = true;
    else if (arg === '--csv') args.csv = true;
    else if (arg === '--weeks') {
      const raw = argv[++i] ?? '';
      const value = /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(value) || value < 1 || value > 104) throw new Error('--weeks needs a whole number from 1 to 104');
      args.weeks = value;
    } else if (arg === '--time-zone') {
      const value = argv[++i] ?? '';
      if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(value)) throw new Error('--time-zone needs a zone name such as Asia/Ho_Chi_Minh or UTC');
      args.timeZone = value;
    } else throw new Error(`unknown usage-report argument ${arg}; use --weeks <n>, --by-org, --csv or --time-zone <zone>`);
  }
  return args;
}

/** Reads crove_kernel.usage_weekly() over its own short-lived connection. Refuses a privileged login. */
export async function readUsage(databaseUrl: string, args: UsageArgs): Promise<UsageRow[]> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'crove-usage-report',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    const { rows: who } = await client.query<{ rolname: string; privileged: boolean }>(
      'SELECT rolname, (rolsuper OR rolbypassrls) AS privileged FROM pg_catalog.pg_roles WHERE rolname = current_user',
    );
    if (who[0]?.privileged) {
      throw new Error(`refusing to report as ${who[0].rolname}, a superuser or BYPASSRLS role: connect REPORTER_DATABASE_URL as crove_reporter`);
    }
    const { rows } = await client.query<UsageRow>(
      `SELECT week_start::text AS week_start, iso_week, org_id, org_name, active_orgs, active_users, documents_uploaded,
              documents_emailed, proposals_approved, approved_without_edits, proposals_rejected,
              median_upload_to_approval_seconds, journal_exports, org_exports
       FROM crove_kernel.usage_weekly($1::int, $2::boolean, $3::text)`,
      [args.weeks, args.byOrg, args.timeZone],
    );
    return rows;
  } finally {
    await client.end().catch(() => {});
  }
}

const COLUMNS: ReadonlyArray<{ key: keyof UsageRow | 'approved_without_edits_percent'; title: string }> = [
  { key: 'iso_week', title: 'week' },
  { key: 'week_start', title: 'from' },
  { key: 'org_id', title: 'org_id' },
  { key: 'org_name', title: 'org' },
  { key: 'active_orgs', title: 'active_orgs' },
  { key: 'active_users', title: 'active_users' },
  { key: 'documents_uploaded', title: 'uploaded' },
  { key: 'documents_emailed', title: 'emailed' },
  { key: 'proposals_approved', title: 'approved' },
  { key: 'approved_without_edits', title: 'approved_unedited' },
  { key: 'approved_without_edits_percent', title: 'unedited_pct' },
  { key: 'proposals_rejected', title: 'rejected' },
  { key: 'median_upload_to_approval_seconds', title: 'median_upload_to_approval_h' },
  { key: 'journal_exports', title: 'journal_exports' },
  { key: 'org_exports', title: 'org_exports' },
];

function cell(row: UsageRow, key: (typeof COLUMNS)[number]['key']): string {
  if (key === 'approved_without_edits_percent') {
    return row.proposals_approved === 0 ? '' : `${Math.round((row.approved_without_edits / row.proposals_approved) * 100)}`;
  }
  if (key === 'median_upload_to_approval_seconds') {
    const s = row.median_upload_to_approval_seconds;
    return s === null ? '' : (Number(s) / 3600).toFixed(1);
  }
  if (key === 'org_id' || key === 'org_name') return row[key] ?? (row.org_id === null ? 'ALL' : '');
  return String(row[key]);
}

// RFC 4180 quoting, and a leading apostrophe for cells a spreadsheet would read as a formula (an org name is the
// only free text here).
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The rows as CSV (header first) or as an aligned plain-text table. */
export function formatUsage(rows: readonly UsageRow[], args: Pick<UsageArgs, 'byOrg' | 'csv'>): string {
  const columns = COLUMNS.filter((c) => args.byOrg || (c.key !== 'org_id' && c.key !== 'org_name'));
  const table = rows.map((r) => columns.map((c) => cell(r, c.key)));
  const header = columns.map((c) => c.title);
  if (args.csv) return [header, ...table].map((line) => line.map(csvCell).join(',')).join('\n');
  // Plain text: one line per row, no control characters from an org name.
  const printable = [header, ...table].map((line) => line.map((v) => Array.from(v, (ch) => (ch < ' ' || ch === '\u007f' ? ' ' : ch)).join('')));
  const widths = header.map((_, i) => Math.max(...printable.map((line) => (line[i] ?? '').length)));
  return printable.map((line) => line.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ').trimEnd()).join('\n');
}

export interface UsageDeps {
  readUsage?: typeof readUsage;
  log?: (text: string) => void;
  error?: (line: string) => void;
}

/** Entry point for `main.ts usage-report [...]`. Resolves to the exit code. Never throws. */
export async function runUsageReport(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, deps: UsageDeps = {}): Promise<number> {
  const log = deps.log ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((line: string) => console.error(line));
  let args: UsageArgs;
  try {
    args = parseUsageArgs(argv);
  } catch (e) {
    error(`[usage-report] ${e instanceof Error ? e.message : String(e)}`);
    return USAGE_EXIT.failed;
  }
  const url = env.REPORTER_DATABASE_URL?.trim();
  if (!url) {
    error('[usage-report] REPORTER_DATABASE_URL is not set; connect it as crove_reporter');
    return USAGE_EXIT.failed;
  }
  try {
    const rows = await (deps.readUsage ?? readUsage)(url, args);
    log(formatUsage(rows, args));
    return USAGE_EXIT.ok;
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
    error(`[usage-report] could not read crove_kernel.usage_weekly(): ${reason}`);
    return USAGE_EXIT.failed;
  }
}
