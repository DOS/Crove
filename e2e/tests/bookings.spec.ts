// Bookings end to end (#1320, plan docs/plan/calendar.md step C5): a visitor books a slot on the public booking page, the
// worker confirms it, the host sees it on the Bookings screen and cancels it, and the slot is offered again.
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('a visitor books on the public page, the host sees it in the app, cancels it, and the slot is free again', async ({ page, browser }) => {
  const email = newEmail('bookings');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Lịch Hẹn');

  await test.step('the host has an event type and keeps every hour open', async () => {
    const vars = { slug, email };
    // Every day, all day, in Vietnam time, and no notice: the test finds a slot whatever day it runs.
    exec(
      `INSERT INTO crove_kernel.availability_rule (org_id, user_id, weekday, start_minute, end_minute, time_zone)
       SELECT t.org_id, u.id, d, 0, 1440, 'Asia/Ho_Chi_Minh'
         FROM crove_kernel.tenant t, crove_kernel.user_account u, generate_series(1, 7) d
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      vars,
    );
    exec(
      `INSERT INTO crove_crm.event_type (org_id, slug, title, duration_min, min_notice_min, host_user_id, created_by)
       SELECT t.org_id, 'tu-van', 'Tư vấn thuế', 30, 0, u.id, u.id
         FROM crove_kernel.tenant t, crove_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      vars,
    );
  });

  let startsAt = '';
  await test.step('a visitor with no account books the first slot of the second day offered', async () => {
    const visitor = await browser.newPage({ timezoneId: 'Asia/Ho_Chi_Minh' });
    await visitor.goto(`/-/b/${slug}/tu-van`);
    await expect(visitor.getByRole('heading', { name: 'Tư vấn thuế' })).toBeVisible();
    // Not today's first slot, which may start within the minute.
    await visitor.locator('main li').nth(1).getByRole('button').first().click();
    await visitor.getByLabel('Họ và tên').fill('Nguyễn Văn Khách');
    await visitor.getByLabel('Email').fill('khach-e2e@example.test');
    await visitor.getByRole('button', { name: 'Đặt lịch' }).click();
    await expect(visitor.getByText('Đã đặt lịch')).toBeVisible({ timeout: 30_000 });
    await visitor.close();
    const [booking] = sql<{ starts_at: string }>(
      `SELECT to_char(b.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS starts_at
         FROM crove_crm.booking b JOIN crove_kernel.tenant t USING (org_id) WHERE t.slug = :'slug' AND b.status = 'confirmed'`,
      { slug },
    );
    startsAt = booking?.starts_at ?? '';
    expect(startsAt).not.toBe('');
  });

  const slots = async (): Promise<string[]> => {
    const from = new Date(Date.parse(startsAt) - 86_400_000).toISOString();
    const to = new Date(Date.parse(startsAt) + 86_400_000).toISOString();
    const res = await page.request.get(`/api/booking/${slug}/tu-van?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { slots: { start: string }[] }).slots.map((s) => s.start);
  };

  await test.step('the booked time is no longer offered', async () => {
    expect(await slots()).not.toContain(startsAt);
  });

  await test.step('the host sees the booking on the Bookings screen and cancels it', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Lịch hẹn' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/bookings$`));
    const row = page.getByTestId('booking-row').filter({ hasText: 'Nguyễn Văn Khách' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Đã xác nhận')).toBeVisible();
    await row.getByRole('button', { name: 'Hủy', exact: true }).click();
    await row.getByRole('button', { name: 'Hủy lịch hẹn' }).click();
    await expect(row.getByText('Đã hủy')).toBeVisible();
  });

  await test.step('the slot is offered again, and the visitor got a cancel mail', async () => {
    expect(await slots()).toContain(startsAt);
    const mails = sql<{ source: string }>(
      `SELECT m.source FROM crove_kernel.mail_message m JOIN crove_kernel.tenant t USING (org_id)
        WHERE t.slug = :'slug' AND m.to_address = 'khach-e2e@example.test' ORDER BY m.created_at`,
      { slug },
    );
    expect(mails.map((m) => m.source)).toEqual(['crm.booking.confirmed', 'crm.booking.cancelled']);
  });
});
