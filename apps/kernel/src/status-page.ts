// The public status page (#678, plan §7.10 "Status page: simple"): the prober writes the result of each probe to a
// small JSON file (PROBER_STATUS_FILE), and the API draws PUBLIC_URL/status from it (STATUS_FILE, the same file on a
// shared volume). No third party, no database read from the page, no script. The file holds only which checks failed
// and when, never a count, a message or anything about an org: the page is public.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DEFAULT_BRAND_NAME } from './config.ts';

// What the page shows, and the prober checks (prober.ts) behind each. A check not listed shows on no line.
export const STATUS_COMPONENTS = [
  { id: 'documents', label: 'Xử lý chứng từ tải lên', checks: ['heartbeat', 'job_age', 'dead_letters', 'jobs_schema', 'extraction'] },
  { id: 'email', label: 'Nhận hóa đơn qua email', checks: ['inbound', 'heartbeat'] },
  { id: 'updates', label: 'Cập nhật trực tiếp trên màn hình', checks: ['outbox', 'notify_queue'] },
  // Supabase Auth's health check (#1994): unknown unless the probe asked Auth (authChecked).
  { id: 'signin', label: 'Đăng nhập', checks: ['auth'] },
] as const;

// A probe older than this is no news: the prober or the volume is gone. Three default probe intervals (300 s).
export const STATUS_STALE_SECONDS = 900;
// The file is tiny; anything larger is not one the prober wrote.
const MAX_STATUS_BYTES = 16 * 1024;

// A field it does not know is dropped, not refused: after a rollback the API may run an older build than the prober,
// which writes fields that build has never heard of (#1994's authChecked), and the page must still show the rest.
const statusSchema = z.object({
  version: z.literal(1),
  checkedAt: z.iso.datetime(),
  // false: the prober could not read the database (its "probe" finding).
  databaseOk: z.boolean(),
  // The checks that failed, by name (only when the database could be read).
  failing: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(32),
  // The probe asked Supabase Auth (#1994); absent from a prober without the check, or with it off.
  authChecked: z.boolean().optional(),
});
export type ProbeStatus = z.infer<typeof statusSchema>;

export function probeStatus(at: Date, failing: string[] | null, authChecked = false): ProbeStatus {
  return { version: 1, checkedAt: at.toISOString(), databaseOk: failing !== null, failing: failing ?? [], ...(authChecked ? { authChecked } : {}) };
}

// Written next to the file and renamed over it, so a reader never sees half a file.
export async function writeStatusFile(path: string, status: ProbeStatus): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(status)}\n`, { mode: 0o644 });
  await rename(temp, path);
}

// null when the file is missing, too large or not in the prober's shape.
export async function readStatusFile(path: string): Promise<ProbeStatus | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  if (text.length > MAX_STATUS_BYTES) return null;
  try {
    const parsed = statusSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type ComponentState = 'ok' | 'problem' | 'unknown';

export interface StatusView {
  // unknown: no file, or older than STATUS_STALE_SECONDS.
  overall: 'ok' | 'problem' | 'unknown';
  checkedAt: string | null;
  components: { id: string; label: string; state: ComponentState }[];
}

export function statusView(status: ProbeStatus | null, now: Date): StatusView {
  const fresh = status !== null && now.getTime() - Date.parse(status.checkedAt) <= STATUS_STALE_SECONDS * 1000;
  const rows: StatusView['components'] = [
    { id: 'database', label: 'Cơ sở dữ liệu', state: !fresh ? 'unknown' : status.databaseOk ? 'ok' : 'problem' },
    ...STATUS_COMPONENTS.map((c) => ({
      id: c.id,
      label: c.label,
      state: (!fresh || !status.databaseOk || (c.id === 'signin' && status.authChecked !== true)
        ? 'unknown'
        : c.checks.some((check) => status.failing.includes(check))
          ? 'problem'
          : 'ok') as ComponentState,
    })),
  ];
  const overall = !fresh ? 'unknown' : rows.some((r) => r.state === 'problem') ? 'problem' : 'ok';
  return { overall, checkedAt: status?.checkedAt ?? null, components: rows };
}

export const STATUS_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HEADLINE = {
  ok: 'Mọi chức năng đang hoạt động bình thường',
  problem: 'Một số chức năng đang gặp sự cố',
  unknown: 'Chưa có kết quả kiểm tra gần đây',
} as const;
const STATE_TEXT = { ok: 'Bình thường', problem: 'Đang gặp sự cố', unknown: 'Chưa rõ' } as const;

// Vietnam time, as the users read it: 20/10/2026 19:05 (giờ Việt Nam).
function vietnamTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')} (giờ Việt Nam)`;
}

// Every text on the page is a constant of this file or a formatted date: nothing from the request or the file is
// written into it as text.
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// brand: the product name users see (BRAND_NAME, #1045).
export function renderStatusPage(view: StatusView, brand = DEFAULT_BRAND_NAME): string {
  const rows = view.components
    .map((c) => `<li><span>${c.label}</span><span class="state ${c.state}">${STATE_TEXT[c.state]}</span></li>`)
    .join('\n');
  const checked = view.checkedAt
    ? `Kiểm tra lần cuối: ${vietnamTime(view.checkedAt)}. Trang tự kiểm tra lại mỗi 5 phút.`
    : 'Hệ thống giám sát chưa gửi kết quả nào.';
  const unknownNote =
    view.overall === 'unknown'
      ? '<p class="note">Không có nghĩa là ứng dụng đang lỗi: trang này chỉ chưa nhận được kết quả kiểm tra mới. Nếu bạn vẫn dùng được ứng dụng thì chưa cần làm gì.</p>'
      : '';
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="300">
<title>Trạng thái hệ thống - ${escapeHtml(brand)}</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #52525b; --card: #ffffff; --line: #e4e4e7; --ok: #15803d; --problem: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; --card: #18181b; --line: #27272a; --ok: #4ade80; --problem: #f87171; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); }
main { max-width: 36rem; margin: 0 auto; padding: 2.5rem 1rem 3rem; }
h1 { font-size: 1.375rem; margin: 0 0 0.5rem; }
p { color: var(--muted); margin: 0.5rem 0; }
ul { list-style: none; padding: 0; margin: 1.5rem 0; border: 1px solid var(--line); border-radius: 0.75rem; background: var(--card); }
li { display: flex; justify-content: space-between; gap: 1rem; padding: 0.875rem 1rem; border-top: 1px solid var(--line); }
li:first-child { border-top: 0; }
.state { font-weight: 600; white-space: nowrap; }
.state.ok { color: var(--ok); }
.state.problem { color: var(--problem); }
.state.unknown { color: var(--muted); }
.note { font-size: 0.875rem; }
</style>
</head>
<body>
<main>
<h1>${HEADLINE[view.overall]}</h1>
<p>${checked}</p>
${unknownNote}
<ul>
${rows}
</ul>
<p class="note">Khi một chức năng gặp sự cố, người quản trị được báo tự động. Việc đang chờ được xử lý tiếp khi chức năng đó chạy lại.</p>
</main>
</body>
</html>
`;
}
