// The status the tax portal shows for an invoice ("Trạng thái hóa đơn"), read into PORTAL_INVOICE_STATUSES (#465).
// The portal writes it in words ("Hóa đơn mới", "Hóa đơn đã bị thay thế"); its own lookup API numbers the same six
// states 1 to 6, which some exports and tools show instead. Diacritics, case and spacing do not matter, so a label
// retyped or saved by another tool still reads. Anything else is 'unknown' and counts like a valid invoice (Crove
// would rather ask for an XML too many than miss one).
import type { PortalInvoiceStatus } from '@crove/kernel-contract';

const BY_NUMBER: Readonly<Record<string, PortalInvoiceStatus>> = {
  '1': 'original',
  '2': 'replacement',
  '3': 'adjustment',
  '4': 'replaced',
  '5': 'adjusted',
  '6': 'cancelled',
};

// Lower case, without diacritics (đ becomes d), single spaces.
export function foldVietnamese(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function portalStatus(label: string | null): PortalInvoiceStatus {
  if (label === null) return 'unknown';
  const folded = foldVietnamese(label);
  if (Object.hasOwn(BY_NUMBER, folded)) return BY_NUMBER[folded] as PortalInvoiceStatus;
  // The order matters: "đã bị thay thế" contains "thay thế", "đã bị điều chỉnh" contains "điều chỉnh".
  // "Hoá đơn đã bị xoá/huỷ bỏ" is how one portal screen words it.
  if (/\b(huy|xoa)\b/.test(folded)) return 'cancelled';
  if (/bi thay the/.test(folded)) return 'replaced';
  if (/bi dieu chinh/.test(folded)) return 'adjusted';
  if (/thay the/.test(folded)) return 'replacement';
  if (/dieu chinh/.test(folded)) return 'adjustment';
  if (/\b(moi|goc)\b/.test(folded)) return 'original';
  return 'unknown';
}
