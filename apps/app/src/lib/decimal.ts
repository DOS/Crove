// Exact decimal arithmetic on strings for client-side previews (BigInt based). Amounts arrive with up to 8 decimals
// (zMoney); the ledger keeps 4 (NUMERIC(20,4)), rounded half away from zero like decimal.js ROUND_HALF_UP in
// @crove/l10n-vn's toMoney. Sums are taken exactly at 8 decimals and rounded once, where the server rounds.
const SCALE = 10_000n;
const EXACT = 100_000_000n;
const TO_LEDGER = EXACT / SCALE;

function parse(value: string, scale: bigint, digits: number): bigint {
  const negative = value.startsWith('-');
  const [i = '0', f = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(i || '0') * scale + BigInt((f + '0'.repeat(digits)).slice(0, digits));
  return negative ? -units : units;
}

// A decimal string in ledger units (4 decimals); digits past the fourth are dropped.
export function toUnits(value: string): bigint {
  return parse(value, SCALE, 4);
}

// A decimal string in exact units (8 decimals, the most the API carries).
function toExact(value: string): bigint {
  return parse(value, EXACT, 8);
}

// Whether a decimal string is zero ("0", "0.0000", "-0.00"), however many decimals the server sends. Used to leave zero
// amounts out of debit and credit columns; a string comparison would miss any other spelling of zero.
export function isZeroAmount(value: string): boolean {
  return /^[+-]?(0+(\.0*)?|\.0+)$/.test(value.trim());
}

// Whether the debits and credits of the lines add up to the same amount (exactly, on the 4 decimals money carries).
export function linesBalance(lines: ReadonlyArray<{ debit: string; credit: string }>): boolean {
  return lines.reduce((acc, l) => acc + toUnits(l.debit) - toUnits(l.credit), 0n) === 0n;
}

export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const int = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export interface PreviewLine {
  debitAccount: string;
  amount: string;
  vatRate: string | null;
}

// Integer division rounding half away from zero, like decimal.js ROUND_HALF_UP.
function divRound(n: bigint, d: bigint): bigint {
  const negative = n < 0n;
  const q = ((negative ? -n : n) * 2n + d) / (2n * d);
  return negative ? -q : q;
}

// Mirrors vatPercent / parseVatRate in @crove/l10n-vn (apps/app does not depend on it; decimal.test.ts keeps the two
// in step): a rate 0-100 with an optional "%", or "KHAC:r%" with 0 < r <= 100, as exact units (8 decimals); exempt,
// untaxed, bare "KHAC" and unreadable rates count as 0.
export function vatPercent(rate: string | null): bigint {
  const text = (rate ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const match = /^(?:KHAC:)?(\d{1,3}(?:\.\d+)?)%?$/.exec(text);
  if (!match?.[1]) return 0n;
  const percent = parse(match[1], EXACT, 8);
  if (percent > 100n * EXACT) return 0n;
  return percent;
}

// Mirrors fixedAssetVat in @crove/l10n-vn: 1332 for fixed assets, estimated per line on mixed invoices and rounded
// to whole VND. Exact units in and out.
function fixedAssetVat(lines: PreviewLine[], vat: bigint): bigint {
  const assets = lines.filter((l) => l.debitAccount === '211');
  if (assets.length === 0 || vat === 0n) return 0n;
  if (assets.length === lines.length) return vat;
  const estimate = divRound(
    assets.reduce((acc, l) => acc + toExact(l.amount) * vatPercent(l.vatRate), 0n),
    100n * EXACT * EXACT,
  ) * EXACT;
  const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);
  return vat > 0n ? clamp(estimate, 0n, vat) : clamp(estimate, vat, 0n);
}

export interface PreviewJournalLine {
  accountCode: string;
  debit: string;
  credit: string;
}

// Mirrors @crove/l10n-vn buildPurchaseJournal for the approval preview; the server recomputes on approve. Each
// account's amount is summed exactly and rounded once to the ledger's 4 decimals, as toMoney does, and the payable
// (331) balances the rounded lines, so the preview shows the very amounts the ledger will hold.
export function previewPurchaseJournal(lines: PreviewLine[], vatTotal: string): PreviewJournalLine[] {
  const ledger = (exact: bigint) => fromUnits(divRound(exact, TO_LEDGER));
  const byAccount = new Map<string, bigint>();
  for (const l of lines) byAccount.set(l.debitAccount, (byAccount.get(l.debitAccount) ?? 0n) + toExact(l.amount));
  const out: PreviewJournalLine[] = [];
  for (const [account, exact] of [...byAccount.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (exact === 0n) continue;
    out.push(exact < 0n ? { accountCode: account, debit: '0', credit: ledger(-exact) } : { accountCode: account, debit: ledger(exact), credit: '0' });
  }
  const vat = toExact(vatTotal);
  const assetVat = fixedAssetVat(lines, vat);
  for (const [accountCode, value] of [['1331', vat - assetVat], ['1332', assetVat]] as const) {
    if (value === 0n) continue;
    out.push(value < 0n ? { accountCode, debit: '0', credit: ledger(-value) } : { accountCode, debit: ledger(value), credit: '0' });
  }
  const net = out.reduce((acc, l) => acc + toUnits(l.debit) - toUnits(l.credit), 0n);
  if (net !== 0n) out.push(net > 0n ? { accountCode: '331', debit: '0', credit: fromUnits(net) } : { accountCode: '331', debit: fromUnits(-net), credit: '0' });
  return out;
}

// Mirrors @crove/l10n-vn buildSalesJournal (issue #313): Cr each line's revenue account, Cr 3331 for the VAT, and the
// receivable (131) first, balancing the rounded lines. `debitAccount` of a sale line is its revenue account.
export function previewSalesJournal(lines: PreviewLine[], vatTotal: string): PreviewJournalLine[] {
  const ledger = (exact: bigint) => fromUnits(divRound(exact, TO_LEDGER));
  const byAccount = new Map<string, bigint>();
  for (const l of lines) byAccount.set(l.debitAccount, (byAccount.get(l.debitAccount) ?? 0n) + toExact(l.amount));
  const credits: PreviewJournalLine[] = [];
  const credit = (accountCode: string, exact: bigint) => {
    if (exact === 0n) return;
    credits.push(exact < 0n ? { accountCode, debit: ledger(-exact), credit: '0' } : { accountCode, debit: '0', credit: ledger(exact) });
  };
  for (const [account, exact] of [...byAccount.entries()].sort(([a], [b]) => a.localeCompare(b))) credit(account, exact);
  credit('3331', toExact(vatTotal));
  const net = credits.reduce((acc, l) => acc + toUnits(l.credit) - toUnits(l.debit), 0n);
  if (net === 0n) return credits;
  const receivable = net > 0n ? { accountCode: '131', debit: fromUnits(net), credit: '0' } : { accountCode: '131', debit: '0', credit: fromUnits(-net) };
  return [receivable, ...credits];
}
