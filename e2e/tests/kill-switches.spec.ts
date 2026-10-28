// The kill switch rehearsal on the compose stack (Phase 1 exit criterion 8, #1718; docs/runbooks/incidents.md §7):
// the org switch from the Agents page, then the operator's deployment switches through tools/ops/kill-switch.mjs
// ('ai', 'mail' and one relay type), each engaged, checked to stop what it stops, and released. Every deployment
// switch is released after each test and after the file, pass or fail, so the shared stack is never left stopped.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { engage, release, releaseAll, status } from '../lib/kill-switch.ts';
import { MAILPIT_URL } from '../lib/mail.ts';
import { createOrg, newEmail, signInNewUser, storedSession } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const REASON = 'Diễn tập tiêu chí 8';
// The relay type the rehearsal holds: a visitor's booking, which the worker confirms only once it is relayed.
const RELAY_TYPE = 'crm.booking.requested';
// A PDF the sniffer accepts (it starts with %PDF-). AI never reads it: the switch stops it first.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [] /Count 0>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n');

// A run killed before its cleanup (a local Ctrl+C) leaves nothing engaged for this file either.
test.beforeAll(async () => {
  await releaseAll();
});

test.afterEach(async () => {
  await releaseAll();
});

test.afterAll(async () => {
  await releaseAll();
});

const dbNow = (): string => sql<{ now: string }>('SELECT now()::text AS now')[0]?.now ?? '';

// The worker's refusals to start a run because a kill switch is on: kernel.agent.run.start answers kill_switch when a
// wake-up arrives while the org's switch or the deployment's 'ai' is engaged.
function refusedWakeups(slug: string, since: string): number {
  return (
    sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM crove_kernel.audit_event a JOIN crove_kernel.tenant t USING (org_id)
        WHERE t.slug = :'slug' AND a.command = 'kernel.agent.run.start' AND a.detail->>'reason' = 'kill_switch'
          AND a.occurred_at > :'since'::timestamptz`,
      { slug, since },
    )[0]?.n ?? 0
  );
}

function runsStarted(slug: string, since: string): number {
  return (
    sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM crove_kernel.ai_run r JOIN crove_kernel.tenant t USING (org_id)
        WHERE t.slug = :'slug' AND r.started_at > :'since'::timestamptz`,
      { slug, since },
    )[0]?.n ?? 0
  );
}

// A task for the agent's position, as a member gives one: it wakes the agent (kernel.agent.wakeup_requested).
async function wakeAgent(page: Page, slug: string, positionId: string, title: string): Promise<void> {
  const session = await storedSession(page);
  const response = await page.request.post('/api/rpc/tasks/create', {
    headers: { authorization: `Bearer ${session?.access_token ?? ''}`, 'x-crove-org': slug },
    data: { json: { title, assigneePositionId: positionId, idempotencyKey: randomUUID() } },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function mailpitCount(to: string): Promise<number> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  if (!response.ok) throw new Error(`Mailpit search: ${response.status}`);
  return ((await response.json()) as { messages: unknown[] | null }).messages?.length ?? 0;
}

test('the org switch on the Agents page and the deployment ai switch refuse agent wake-ups, and ai leaves a new PDF unread', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('kill-ai'));
  const slug = await createOrg(page, 'Công ty Diễn Tập Dừng AI');

  const positionId = await test.step('an owner installs an agent, with a second factor (R3)', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Sơ đồ và AI' }).click();
    await expect(page.getByRole('heading', { name: 'Sơ đồ tổ chức và tác tử AI' })).toBeVisible();
    await page.getByTestId('template').first().getByRole('button', { name: 'Cài', exact: true }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByText('Đã cài tác tử AI và vị trí của nó.')).toBeVisible();
    const [position] = sql<{ id: string }>(
      `SELECT p.id FROM crove_kernel.position p JOIN crove_kernel.tenant t USING (org_id)
        WHERE t.slug = :'slug' AND p.holder_agent_id IS NOT NULL AND p.status = 'active'`,
      { slug },
    );
    expect(position?.id).toBeTruthy();
    return position?.id ?? '';
  });

  try {
    await test.step('the org switch, engaged from the Agents page, refuses the agent a wake-up', async () => {
      await page.getByRole('button', { name: 'Dừng AI', exact: true }).click();
      await page.getByLabel('Lý do (không bắt buộc)').fill(REASON);
      await page.getByRole('button', { name: 'Dừng AI ngay' }).click();
      await expect(page.getByText('AI đang bị dừng')).toBeVisible();
      await expect(page.getByText(`Lý do: ${REASON}`, { exact: false }).first()).toBeVisible();

      const since = dbNow();
      await wakeAgent(page, slug, positionId, 'Diễn tập: đối chiếu công nợ');
      await expect.poll(() => refusedWakeups(slug, since), { message: 'a wake-up refused by the org switch', timeout: 60_000 }).toBeGreaterThan(0);
      expect(runsStarted(slug, since)).toBe(0);
    });

    await test.step('an owner with a fresh second factor releases it from the same page', async () => {
      await page.getByRole('button', { name: 'Bật lại AI' }).click();
      await expect(page.getByText('AI đang bị dừng')).toHaveCount(0);
      expect(sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM crove_kernel.kill_switch k JOIN crove_kernel.tenant t USING (org_id)
          WHERE t.slug = :'slug' AND k.released_at IS NULL`,
        { slug },
      )).toEqual([{ n: 0 }]);
    });

    await test.step("the deployment's ai switch, engaged by the operator's script, refuses the agent a wake-up", async () => {
      const since = dbNow();
      const engaged = await engage('ai', REASON);
      expect(engaged.find((s) => s.key === 'ai')).toMatchObject({ engaged: true, last: { reason: REASON } });
      await wakeAgent(page, slug, positionId, 'Diễn tập: lập tờ khai');
      await expect.poll(() => refusedWakeups(slug, since), { message: "a wake-up refused by the deployment's ai switch", timeout: 60_000 }).toBeGreaterThan(0);
    });

    await test.step('a new PDF in the Inbox is left unread: "AI đang tạm dừng"', async () => {
      await page.goto(`/o/${slug}/inbox`);
      await expect(page.getByRole('heading', { name: 'Hộp thư chứng từ' })).toBeVisible();
      await page.locator('input[type=file]').setInputFiles({ name: 'hoa-don-dien-tap.pdf', mimeType: 'application/pdf', buffer: PDF });
      await expect(page.getByText(/^AI đang tạm dừng trong tổ chức nên chưa đọc tệp này/)).toBeVisible({ timeout: 60_000 });
      const [file] = sql<{ status: string; error: string | null }>(
        `SELECT e.status, e.error FROM crove_kernel.extraction e JOIN crove_kernel.tenant t USING (org_id)
          JOIN crove_kernel.file f ON f.org_id = e.org_id AND f.id = e.file_id
         WHERE t.slug = :'slug' AND f.filename = 'hoa-don-dien-tap.pdf'`,
        { slug },
      );
      expect(file).toMatchObject({ status: 'failed', error: expect.stringMatching(/^AI đang tạm dừng/) });
    });
  } finally {
    await release('ai');
  }
  // Released: the switch's history keeps who engaged it and why, then who released it.
  expect(
    sql<{ engaged: boolean; changed_by: string; reason: string | null }>(
      `SELECT engaged, changed_by, reason FROM crove_kernel.global_kill_switch WHERE key = 'ai' ORDER BY changed_at DESC, id DESC LIMIT 2`,
    ),
  ).toEqual([
    { engaged: false, changed_by: 'e2e kill-switch rehearsal', reason: null },
    { engaged: true, changed_by: 'e2e kill-switch rehearsal', reason: REASON },
  ]);
});

test('the deployment relay and mail switches hold a booking and its mail, and release them in order', async ({ page, browser }) => {
  const email = newEmail('kill-mail');
  const visitorEmail = newEmail('kill-visitor');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Diễn Tập Giữ Thư');

  await test.step('the host keeps every hour open for a 30-minute event type', async () => {
    const vars = { slug, email };
    exec(
      `INSERT INTO crove_kernel.availability_rule (org_id, user_id, weekday, start_minute, end_minute, time_zone, created_by)
       SELECT t.org_id, u.id, d, 0, 1440, 'Asia/Ho_Chi_Minh', u.id
         FROM crove_kernel.tenant t, crove_kernel.user_account u, generate_series(1, 7) d
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      vars,
    );
    exec(
      `INSERT INTO crove_crm.event_type (org_id, slug, title, duration_min, min_notice_min, host_user_id, created_by)
       SELECT t.org_id, 'dien-tap', 'Diễn tập', 30, 0, u.id, u.id
         FROM crove_kernel.tenant t, crove_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      vars,
    );
  });

  const relayKey = `relay:${RELAY_TYPE}`;
  const booking = () =>
    sql<{ status: string; pending: boolean }>(
      `SELECT b.status,
              EXISTS (SELECT 1 FROM crove_kernel.outbox_event e JOIN crove_kernel.outbox_pending p ON p.org_id = e.org_id AND p.event_id = e.id
                       WHERE e.org_id = b.org_id AND e.type = :'type' AND e.payload->>'booking_id' = b.id::text) AS pending
         FROM crove_crm.booking b JOIN crove_kernel.tenant t USING (org_id) WHERE t.slug = :'slug'`,
      { slug, type: RELAY_TYPE },
    );
  const mails = () =>
    sql<{ status: string }>(
      `SELECT m.status FROM crove_kernel.mail_message m JOIN crove_kernel.tenant t USING (org_id)
        WHERE t.slug = :'slug' AND m.to_address = :'to' AND m.source = 'crm.booking.confirmed'`,
      { slug, to: visitorEmail },
    );

  const visitor = await browser.newPage({ timezoneId: 'Asia/Ho_Chi_Minh' });
  try {
    await test.step(`the operator holds ${relayKey} and mail`, async () => {
      await engage(relayKey, REASON);
      const engaged = await engage('mail', REASON);
      expect(engaged.filter((s) => s.engaged).map((s) => s.key).sort()).toEqual(['mail', relayKey]);
    });

    await test.step('a visitor books; the relay holds the request, so it waits unconfirmed', async () => {
      await visitor.goto(`/-/b/${slug}/dien-tap`);
      await expect(visitor.getByRole('heading', { name: 'Diễn tập' })).toBeVisible();
      await visitor.locator('main li').nth(1).getByRole('button').first().click();
      await visitor.getByLabel('Họ và tên').fill('Trần Thị Diễn Tập');
      await visitor.getByLabel('Email').fill(visitorEmail);
      await visitor.getByRole('button', { name: 'Đặt lịch' }).click();
      await expect(visitor.getByText('Đang giữ chỗ cho bạn...')).toBeVisible();
      await expect.poll(() => booking(), { message: 'the booking request recorded' }).toEqual([{ status: 'pending', pending: true }]);
      // The relay passes every second or so; several passes later the request is still held.
      await page.waitForTimeout(5_000);
      expect(booking()).toEqual([{ status: 'pending', pending: true }]);
      // What `pnpm ops:kill-switch status` prints as "holding N event(s)".
      const held = (await status()).find((s) => s.key === relayKey);
      expect(held?.held).toBeGreaterThanOrEqual(1);
    });

    await test.step('released, the relay sends the request: the booking is confirmed and its mail queued, still held', async () => {
      await release(relayKey);
      await expect(visitor.getByText('Đã đặt lịch')).toBeVisible({ timeout: 30_000 });
      expect(booking()).toEqual([{ status: 'confirmed', pending: false }]);
      await expect.poll(() => mails(), { message: "the visitor's confirmation queued" }).toEqual([{ status: 'queued' }]);
      // The mail sweep runs every 10 s; past one, the held mail is still queued and Mailpit has nothing.
      await page.waitForTimeout(12_000);
      expect(mails()).toEqual([{ status: 'queued' }]);
      expect(await mailpitCount(visitorEmail)).toBe(0);
    });

    await test.step('released, the mail goes out to Mailpit', async () => {
      await release('mail');
      await expect.poll(() => mailpitCount(visitorEmail), { message: "the visitor's confirmation in Mailpit", timeout: 60_000 }).toBeGreaterThan(0);
      await expect.poll(() => mails().map((m) => m.status), { timeout: 30_000 }).toEqual(['sent']);
    });
  } finally {
    await visitor.close();
    await releaseAll();
  }
});
