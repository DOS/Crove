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
  if (vat !== 0n) {
    const accountCode = lines.some((l) => l.debitAccount === '211') ? '1332' : '1331';
    out.push(vat < 0n ? { accountCode, debit: '0', credit: fromUnits(-vat) } : { accountCode, debit: fromUnits(vat), credit: '0' });
  }
  const net = out.reduce((acc, l) => acc + toUnits(l.debit) - toUnits(l.credit), 0n);
  if (net !== 0n) out.push(net > 0n ? { accountCode: '331', debit: '0', credit: fromUnits(net) } : { accountCode: '331', debit: fromUnits(-net), credit: '0' });
  return out;
}
