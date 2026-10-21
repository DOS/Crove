// Inbox steps shared by the specs.
import type { Page } from '@playwright/test';

// The fixture invoices carry a placeholder, not a real digital signature, so the Inbox shows them as unverified and
// asks the approver to confirm they checked the original first (#674). Ticks that confirmation on a proposal page.
export async function confirmUnverifiedSignature(page: Page): Promise<void> {
  await page.getByText('Tôi đã kiểm tra hóa đơn gốc và vẫn muốn duyệt').click();
}
