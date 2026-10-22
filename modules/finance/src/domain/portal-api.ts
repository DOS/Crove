// The tax portal's lookup API rows as Crove reads them (issue #325, ADR-0036): pure, so the API (before it stores the
// portal's answer) and the worker (when it records the list) apply the same rules. The portal's JSON is untrusted: it
// is parsed with numbers kept as their text, checked with loose shapes, and turned into the list the manual Excel import
// reads (ExtractedPortalList), so checkPortalList and finance.portal_list.record treat both the same way.
import { z } from 'zod';
import { EXTRACT_LIMITS, zExtractedPortalList, type ExtractedPortalList, type PortalListSkipReason } from '@crove/extract-contract';
import { DomainError } from '@crove/kernel-runtime';
import { parseTaxCode } from '@crove/l10n-vn';

// The evidence file of a synced list: the portal's answers as JSON, stored like an import (never read as a document).
export const PORTAL_SYNC_CONTENT_TYPE = 'application/json';

// JSON with every number kept as the text it was written with, so amounts never pass through a float. Throws on
// anything that is not JSON.
export function parseJsonKeepingNumbers(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) => (typeof value === 'number' && context?.source ? context.source : value);
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

// What a list query of the portal returned, by which query: the processing state filter it ran with (ttxly 5: has a
// tax authority code, 6: received without a code, 8: from a cash register) or the cash register endpoint.
export const PORTAL_QUERIES = ['purchase_5', 'purchase_6', 'purchase_8', 'sco'] as const;
export type PortalQuery = (typeof PORTAL_QUERIES)[number];
const CHECK_RESULT: Record<PortalQuery, string> = {
  purchase_5: 'Đã cấp mã hóa đơn',
  purchase_6: 'Cục Thuế đã nhận không mã',
  purchase_8: 'Cục Thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền',
  sco: 'Cục Thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền',
};
// The portal has the signed XML only for invoices with a tax authority code (ttxly 5); for the others it answers an
// error, and the seller sends the XML.
export const XML_CHECK_RESULT = CHECK_RESULT.purchase_5;
// The portal's invoice states 1 to 6, in the words its Excel export uses (portalStatus reads them).
const STATUS_LABELS: Record<string, string> = {
  '1': 'Hóa đơn mới',
  '2': 'Hóa đơn thay thế',
  '3': 'Hóa đơn điều chỉnh',
  '4': 'Hóa đơn đã bị thay thế',
  '5': 'Hóa đơn đã bị điều chỉnh',
  '6': 'Hóa đơn đã bị hủy',
};

export interface PortalAnswer {
  query: PortalQuery;
  // The rows of every page of that query, as the portal sent them (numbers kept as their JSON text).
  rows: unknown[];
}

// One row as the portal's lookup API names its fields. Every field is optional and loosely typed: the answer is
// untrusted, and a row that lacks what an invoice needs is skipped with a reason, never guessed.
const scalar = z.union([z.string().max(1000), z.number(), z.null()]).optional();
const zPortalApiRow = z.looseObject({
  nbmst: scalar,
  nbten: scalar,
  nmmst: scalar,
  khmshdon: scalar,
  khhdon: scalar,
  shdon: scalar,
  tdlap: scalar,
  dvtte: scalar,
  tgtcthue: scalar,
  tgtthue: scalar,
  tgtttbso: scalar,
  tthai: scalar,
});

const text = (value: unknown): string | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const t = value.replace(/[\p{Cc}]+/gu, ' ').trim();
  return t === '' ? null : t;
};

// A tax code the portal may send as a number, which drops a leading zero.
function taxCode(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  const padded = /^\d{9}$/.test(raw) ? `0${raw}` : /^\d{11}$/.test(raw) ? `0${raw}` : raw;
  return parseTaxCode(padded)?.normalized ?? null;
}

const VN_OFFSET_MS = 7 * 3_600_000;
// The invoice date in Vietnam's calendar: the portal sends an instant (epoch milliseconds, or ISO with a zone), a local
// ISO date-time, or dd/mm/yyyy.
export function portalDate(value: unknown): string | null {
  const vnDate = (ms: number) => (Number.isFinite(ms) ? new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10) : null);
  const raw = text(value);
  if (raw === null) return null;
  if (/^\d{10,14}$/.test(raw)) return vnDate(Number(raw));
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(raw)) return vnDate(Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')));
  const iso = /^(\d{4})-(\d{2})-(\d{2})(T[\d:.]+)?$/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const vn = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(raw);
  if (vn) return `${vn[3]}-${vn[2]}-${vn[1]}`;
  return null;
}

const AMOUNT = /^-?\d{1,18}(\.\d{1,6})?$/;
function amount(value: unknown): string | null | 'bad' {
  const raw = text(value);
  if (raw === null) return null;
  return AMOUNT.test(raw) ? raw : 'bad';
}

export interface NormalizedPortalList {
  list: ExtractedPortalList;
  // The rows the portal has an XML for (query purchase_5), by rowNo.
  withXml: Set<number>;
}

// The portal's answers as the list the manual import reads. Rows are numbered in the order the queries ran; a row that
// names an invoice but cannot be read is skipped with the reason (at most EXTRACT_LIMITS.maxPortalListSkipped listed).
export function normalizePortalInvoices(answers: readonly PortalAnswer[], period: { from: string; to: string }): NormalizedPortalList {
  const rows: ExtractedPortalList['rows'] = [];
  const skipped: ExtractedPortalList['skipped'] = [];
  const withXml = new Set<number>();
  let skippedCount = 0;
  let rowNo = 0;
  const skip = (reason: PortalListSkipReason) => {
    skippedCount += 1;
    if (skipped.length < EXTRACT_LIMITS.maxPortalListSkipped) skipped.push({ rowNo, reason });
  };
  for (const answer of answers) {
    for (const raw of answer.rows) {
      rowNo += 1;
      const parsed = zPortalApiRow.safeParse(raw);
      if (!parsed.success) {
        skip('no_number');
        continue;
      }
      const r = parsed.data;
      const series = text(r.khhdon)?.toUpperCase() ?? null;
      const number = text(r.shdon);
      const seller = text(r.nbmst);
      // Nothing that names an invoice: not a row of the list.
      if (series === null && number === null && seller === null) {
        rowNo -= 1;
        continue;
      }
      if (seller === null) {
        skip('no_tax_code');
        continue;
      }
      const sellerTaxCode = taxCode(seller);
      if (!sellerTaxCode) {
        skip('bad_tax_code');
        continue;
      }
      if (number === null) {
        skip('no_number');
        continue;
      }
      if (series === null) {
        skip('no_series');
        continue;
      }
      if (series.length > 20 || number.length > 20 || !/^[0-9A-Z]+$/.test(series) || !/^\d+$/.test(number)) {
        skip('too_long');
        continue;
      }
      const issueDate = portalDate(r.tdlap);
      if (!issueDate) {
        skip('bad_date');
        continue;
      }
      const subtotal = amount(r.tgtcthue);
      const vatAmount = amount(r.tgtthue);
      const total = amount(r.tgtttbso);
      if (subtotal === 'bad' || vatAmount === 'bad' || total === 'bad') {
        skip('bad_amount');
        continue;
      }
      if (rows.length >= EXTRACT_LIMITS.maxPortalListRows) {
        throw new DomainError('PORTAL_LIST_TOO_LARGE', 422, `Kỳ này có hơn ${EXTRACT_LIMITS.maxPortalListRows} hóa đơn trên cổng thuế; hãy xuất danh sách Excel từ cổng thuế rồi tải lên`);
      }
      const template = text(r.khmshdon);
      const currency = text(r.dvtte)?.toUpperCase() ?? 'VND';
      const status = text(r.tthai);
      rows.push({
        rowNo,
        sellerTaxCode,
        sellerName: (text(r.nbten) ?? '').slice(0, 500),
        buyerTaxCode: taxCode(r.nmmst),
        template: template !== null && /^[0-9A-Z]{1,11}$/.test(template) ? template : null,
        series,
        number,
        issueDate,
        currency: /^[A-Z]{3}$/.test(currency) ? currency : 'VND',
        subtotal,
        vatAmount,
        total,
        statusLabel: status === null ? null : (STATUS_LABELS[status] ?? status.slice(0, 200)),
        checkResult: CHECK_RESULT[answer.query],
      });
      if (answer.query === 'purchase_5') withXml.add(rowNo);
    }
  }
  return {
    list: { sheetName: 'hoadondientu.gdt.gov.vn', headerRow: 1, columns: [], listFrom: period.from, listTo: period.to, buyerTaxCode: null, rows, skipped, skippedCount },
    withXml,
  };
}

// The evidence file the API stored for a synced list (apps/kernel/src/portal-sync.ts), read back by the worker: the
// list, or why it cannot be used.
const zEvidence = z.object({
  period: z.string().max(10),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  answers: z.array(z.object({ query: z.enum(PORTAL_QUERIES), rows: z.array(z.unknown()).max(EXTRACT_LIMITS.maxPortalListRows) })).max(PORTAL_QUERIES.length * 3),
});

export function readSyncedList(bytes: Uint8Array, period: { from: string; to: string }): { ok: true; list: ExtractedPortalList } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = parseJsonKeepingNumbers(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { ok: false, error: 'Không đọc được dữ liệu đã lấy từ cổng thuế; hãy lấy lại' };
  }
  const evidence = zEvidence.safeParse(parsed);
  if (!evidence.success || evidence.data.from !== period.from || evidence.data.to !== period.to) {
    return { ok: false, error: 'Dữ liệu đã lấy từ cổng thuế không khớp kỳ này; hãy lấy lại' };
  }
  try {
    const { list } = normalizePortalInvoices(evidence.data.answers, period);
    // The same shape the sandbox answers for an uploaded list, checked the same way.
    if (!zExtractedPortalList.safeParse(list).success) return { ok: false, error: 'Không đọc được dữ liệu đã lấy từ cổng thuế; hãy lấy lại' };
    return { ok: true, list };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, error: error.message };
    throw error;
  }
}
