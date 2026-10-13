// Exact decimal arithmetic on strings for client-side previews (4 decimal places, BigInt based).
const SCALE = 10_000n;

export function toUnits(value: string): bigint {
  const negative = value.startsWith('-');
  const [i = '0', f = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(i || '0') * SCALE + BigInt((f + '0000').slice(0, 4));
  return negative ? -units : units;
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

function vatPercent(rate: string | null): bigint {
  const match = /^(\d{1,2})%$/.exec(rate?.trim() ?? '');
  return match ? BigInt(match[1] ?? '0') : 0n;
}

// Mirrors fixedAssetVat in @crove/l10n-vn: 1332 for fixed assets, estimated per line on mixed invoices.
function fixedAssetVat(lines: PreviewLine[], vat: bigint): bigint {
  const assets = lines.filter((l) => l.debitAccount === '211');
  if (assets.length === 0 || vat === 0n) return 0n;
  if (assets.length === lines.length) return vat;
  const estimate = divRound(
    assets.reduce((acc, l) => acc + toUnits(l.amount) * vatPercent(l.vatRate), 0n),
    100n * SCALE,
  ) * SCALE;
  const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);
  return vat > 0n ? clamp(estimate, 0n, vat) : clamp(estimate, vat, 0n);
}

export interface PreviewJournalLine {
  accountCode: string;
  debit: string;
  credit: string;
}

// Mirrors @crove/l10n-vn buildPurchaseJournal for the approval preview; the server recomputes on approve.
export function previewPurchaseJournal(lines: PreviewLine[], vatTotal: string): PreviewJournalLine[] {
  const byAccount = new Map<string, bigint>();
  for (const l of lines) byAccount.set(l.debitAccount, (byAccount.get(l.debitAccount) ?? 0n) + toUnits(l.amount));
  const out: PreviewJournalLine[] = [];
  for (const [account, units] of [...byAccount.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (units === 0n) continue;
    out.push(units < 0n ? { accountCode: account, debit: '0', credit: fromUnits(-units) } : { accountCode: account, debit: fromUnits(units), credit: '0' });
  }
  const vat = toUnits(vatTotal);
  const assetVat = fixedAssetVat(lines, vat);
  for (const [accountCode, value] of [['1331', vat - assetVat], ['1332', assetVat]] as const) {
    if (value === 0n) continue;
    out.push(value < 0n ? { accountCode, debit: '0', credit: fromUnits(-value) } : { accountCode, debit: fromUnits(value), credit: '0' });
  }
  const net = out.reduce((acc, l) => acc + toUnits(l.debit) - toUnits(l.credit), 0n);
  if (net !== 0n) out.push(net > 0n ? { accountCode: '331', debit: '0', credit: fromUnits(net) } : { accountCode: '331', debit: fromUnits(-net), credit: '0' });
  return out;
}
