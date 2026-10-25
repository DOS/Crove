// Inbox steps shared by the specs.
import type { Locator, Page } from '@playwright/test';

// The fixture invoices carry a placeholder, not a real digital signature, so the Inbox shows them as unverified and
// asks the approver to confirm they checked the original first (#674). Ticks that confirmation on a proposal page.
export async function confirmUnverifiedSignature(page: Page): Promise<void> {
  await page.getByText('Tôi đã kiểm tra hóa đơn gốc và vẫn muốn duyệt').click();
}

// Presses Tab until the target has the focus, as a keyboard-only user reaches it (#1517); fails after max presses, so a
// control the keyboard cannot reach is a test failure.
export async function tabTo(page: Page, target: Locator, max = 80): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab never reached ${String(target)} in ${max} presses`);
}
