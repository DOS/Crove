// DRAFT TT133 B01-DNN and B02-DNN on synthetic sample data (issue #154). The expected values below were
// worked out by hand from the sample journal, line by line, in the comments. An accountant still has to
// check both the mapping and these values before the reports are used for anything real.
import { describe, expect, it } from 'vitest';
import {
  buildB01,
  buildB02,
  emptyLedger,
  lineAmount,
  postEntry,
  reportEntries,
  reverseEntry,
  type LedgerState,
  type Report,
} from '../src/index.ts';

type Leg = [account: string, debit: number | string, credit: number | string, party?: string];

// Synthetic sample: a small trading company founded on 2 January 2026, VND books. Amounts are whole dong.
const LE = 'le-sample';

class Journal {
  private readonly legalEntityId: string;
  constructor(legalEntityId = LE) {
    this.legalEntityId = legalEntityId;
  }
  state: LedgerState = emptyLedger;
  private seq = 0;
  private newId = () => `E${++this.seq}`;

  post(date: string, legs: Leg[]): string {
    const outcome = postEntry(
      this.state,
      {
        legalEntityId: this.legalEntityId,
        entryDate: date,
        currency: 'VND',
        docType: 'NVK',
        source: { type: 'sample', id: `S${this.seq + 1}`, revision: 1 },
        reversesId: null,
        lines: legs.map(([accountCode, debit, credit, party], i) => ({
          lineNo: i + 1,
          accountCode,
          debit: String(debit),
          credit: String(credit),
          partyId: party ?? null,
        })),
      },
      this.newId,
    );
    if (!outcome.ok) throw new Error(`${date}: ${outcome.code} ${outcome.message}`);
    this.state = outcome.state;
    return outcome.entryId;
  }

  reverse(entryId: string, date: string): void {
    const outcome = reverseEntry(this.state, entryId, date, this.newId);
    if (!outcome.ok) throw new Error(`${date}: ${outcome.code} ${outcome.message}`);
    this.state = outcome.state;
  }

  get entries() {
    return reportEntries(this.state.entries);
  }
}

function sampleYear(): Journal {
  const j = new Journal();
  j.post('2026-01-02', [['1121', 500_000_000, 0], ['4111', 0, 500_000_000]]); // owner's capital
  j.post('2026-01-05', [['211', 60_000_000, 0], ['1332', 6_000_000, 0], ['331', 0, 66_000_000, 'V1']]); // equipment on credit, VAT 10%
  const goods = lineAmount('1000', '200000', 'VND'); // 1,000 units x 200,000 = 200,000,000
  j.post('2026-01-10', [['1561', goods, 0], ['1331', 20_000_000, 0], ['331', 0, 220_000_000, 'V2']]); // goods on credit
  j.post('2026-01-15', [['331', 220_000_000, 0, 'V2'], ['1121', 0, 220_000_000]]); // pay V2
  j.post('2026-01-20', [['331', 15_000_000, 0, 'V3'], ['1121', 0, 15_000_000]]); // prepay V3
  j.post('2026-02-01', [['131', 330_000_000, 0, 'C1'], ['5111', 0, 300_000_000], ['33311', 0, 30_000_000]]); // sale to C1
  j.post('2026-02-01', [['632', 150_000_000, 0], ['1561', 0, 150_000_000]]); // cost of that sale
  const wrongSale = j.post('2026-02-05', [['131', 55_000_000, 0, 'C1'], ['5111', 0, 50_000_000], ['33311', 0, 5_000_000]]);
  j.reverse(wrongSale, '2026-02-06'); // posted by mistake, reversed
  j.post('2026-02-10', [['1121', 200_000_000, 0], ['131', 0, 200_000_000, 'C1']]); // C1 pays part
  j.post('2026-02-15', [['1121', 50_000_000, 0], ['131', 0, 50_000_000, 'C2']]); // C2 pays in advance
  j.post('2026-02-20', [['5111', 10_000_000, 0], ['33311', 1_000_000, 0], ['131', 0, 11_000_000, 'C1']]); // price reduction to C1
  j.post('2026-03-01', [['1111', 20_000_000, 0], ['1121', 0, 20_000_000]]); // cash withdrawal
  j.post('2026-03-05', [['6422', 12_000_000, 0], ['1331', 1_200_000, 0], ['1111', 0, 13_200_000]]); // office rent, VAT 10%
  const wrongExpense = j.post('2026-03-10', [['6422', 7_777_000, 0], ['1111', 0, 7_777_000]]);
  j.reverse(wrongExpense, '2026-03-11');
  j.post('2026-03-15', [['6421', 3_000_000, 0], ['1121', 0, 3_000_000]]); // delivery cost
  j.post('2026-03-20', [['1121', 100_000_000, 0], ['341', 0, 100_000_000]]); // bank loan
  j.post('2026-03-31', [['6422', 40_000_000, 0], ['334', 0, 40_000_000]]); // salaries, unpaid
  j.post('2026-06-30', [['6351', 1_000_000, 0], ['1121', 0, 1_000_000]]); // loan interest
  j.post('2026-06-30', [['1121', 500_000, 0], ['515', 0, 500_000]]); // deposit interest
  j.post('2026-07-01', [['1111', 3_000_000, 0], ['711', 0, 3_000_000]]); // scrap sold
  j.post('2026-07-02', [['811', 2_000_000, 0], ['1111', 0, 2_000_000]]); // late-payment fine
  j.post('2026-12-31', [['6422', 5_000_000, 0], ['2141', 0, 5_000_000]]); // depreciation
  j.post('2026-12-31', [['821', 16_100_000, 0], ['3334', 0, 16_100_000]]); // CIT 20% of 80,500,000
  return j;
}

// Year-end closing through 911 into 4212.
function closeYear(j: Journal): void {
  j.post('2026-12-31', [['5111', 290_000_000, 0], ['515', 500_000, 0], ['711', 3_000_000, 0], ['911', 0, 293_500_000]]);
  j.post('2026-12-31', [
    ['911', 229_100_000, 0],
    ['632', 0, 150_000_000],
    ['6421', 0, 3_000_000],
    ['6422', 0, 57_000_000],
    ['6351', 0, 1_000_000],
    ['811', 0, 2_000_000],
    ['821', 0, 16_100_000],
  ]);
  j.post('2026-12-31', [['911', 64_400_000, 0], ['4212', 0, 64_400_000]]);
}

// Report amounts by line code. Expected values are whole dong, written as integer literals (exact in JS).
function amounts(report: Report): Record<string, string> {
  return Object.fromEntries(report.lines.map((l) => [l.code, l.amount]));
}

function asText(values: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, String(value)]));
}

// Hand calculation, 31 December 2026:
// 1111 cash: +20 -13.2 -7.777 +7.777 +3 -2 = 7.8M. 1121 bank: +500 -220 -15 +200 +50 -20 -3 +100 -1 +0.5 = 591.5M.
// 131: C1 330 +55 -55 -200 -11 = 119M debit; C2 50M credit (advance, a liability). 331: V1 66M credit;
// V2 0; V3 15M debit (prepayment, an asset). 1561: 200 -150 = 50M. 211: 60M, 2141: 5M credit.
// 133: 1332 6M + 1331 20M + 1.2M = 27.2M. 33311: 30 +5 -5 -1 = 29M; 3334: 16.1M. 334: 40M. 341: 100M.
// Profit after tax (see B02) 64.4M not closed yet, so code 417 reads it from classes 5 to 8.
const B01_YEAR_END: Record<string, number> = {
  '110': 599_300_000,
  '121': 0, '122': 0, '123': 0, '124': 0, '120': 0,
  '131': 119_000_000, '132': 15_000_000, '133': 0, '134': 0, '135': 0, '136': 0, '130': 134_000_000,
  '141': 50_000_000, '142': 0, '140': 50_000_000,
  '151': 60_000_000, '152': -5_000_000, '150': 55_000_000,
  '161': 0, '162': 0, '160': 0,
  '170': 0,
  '181': 27_200_000, '182': 0, '180': 27_200_000,
  '200': 865_500_000,
  '311': 66_000_000, '312': 50_000_000, '313': 45_100_000, '314': 40_000_000, '315': 0, '316': 100_000_000,
  '317': 0, '318': 0, '319': 0, '320': 0, '300': 301_100_000,
  '411': 500_000_000, '412': 0, '413': 0, '414': 0, '415': 0, '416': 0, '417': 64_400_000, '400': 564_400_000,
  '500': 865_500_000,
};

// Hand calculation, year 2026:
// 01: 5111 credits 300 +50, and the reversal of the wrong sale counts as -50, so 300M. 02: the price
// reduction 10M. 11: 150M. 21: 0.5M. 22 and 23: 1M on 6351. 24: 6422 12 +7.777 -7.777 +40 +5 and 6421 3,
// so 60M. 30 = 140 +0.5 -1 -60 = 79.5M. 31: 3M, 32: 2M. 50 = 80.5M. 51: 16.1M (20%). 60 = 64.4M.
const B02_YEAR: Record<string, number> = {
  '01': 300_000_000, '02': 10_000_000, '10': 290_000_000, '11': 150_000_000, '20': 140_000_000,
  '21': 500_000, '22': 1_000_000, '23': 1_000_000, '24': 60_000_000, '30': 79_500_000,
  '31': 3_000_000, '32': 2_000_000, '40': 1_000_000, '50': 80_500_000, '51': 16_100_000, '60': 64_400_000,
};

describe('TT133 B01-DNN (draft)', () => {
  it('matches the hand calculation at year end and balances', () => {
    const report = buildB01(sampleYear().entries, LE, '2026-12-31');
    expect(amounts(report)).toEqual(asText(B01_YEAR_END));
    expect(report.unmapped).toEqual([]);
    expect(report.balanced).toBe(true);
  });

  it('matches the hand calculation at 31 January 2026', () => {
    // 1121: 500 -220 -15 = 265M. 331: V1 66M credit, V3 15M debit. 1561 200M, 211 60M, 133 26M.
    const report = buildB01(sampleYear().entries, LE, '2026-01-31');
    const nonZero = Object.fromEntries(Object.entries(amounts(report)).filter(([, v]) => v !== '0'));
    expect(nonZero).toEqual(asText({
      '110': 265_000_000, '132': 15_000_000, '130': 15_000_000, '141': 200_000_000, '140': 200_000_000, '151': 60_000_000, '150': 60_000_000,
      '181': 26_000_000, '180': 26_000_000, '200': 566_000_000, '311': 66_000_000, '300': 66_000_000, '411': 500_000_000, '400': 500_000_000, '500': 566_000_000,
    }));
    expect(report.balanced).toBe(true);
  });

  it('is empty and balanced before the first entry', () => {
    const report = buildB01(sampleYear().entries, LE, '2025-12-31');
    expect(report.lines.every((l) => l.amount === '0')).toBe(true);
    expect(report.balanced).toBe(true);
  });

  it('does not change when the year is closed through 911 into 421', () => {
    const j = sampleYear();
    closeYear(j);
    const report = buildB01(j.entries, LE, '2026-12-31');
    expect(amounts(report)).toEqual(asText(B01_YEAR_END));
    expect(report.unmapped).toEqual([]);
  });

  it('reports a balance no line reads instead of dropping it', () => {
    const j = sampleYear();
    j.post('2026-12-31', [['1121', 30_000_000, 0], ['1331', 0, 30_000_000]]); // 1331 ends 8.8M on the credit side
    j.post('2026-12-31', [['999', 1_000_000, 0], ['1121', 0, 1_000_000]]); // not a TT133 account
    const report = buildB01(j.entries, LE, '2026-12-31');
    expect(report.unmapped).toEqual([
      { accountCode: '1331', partyId: null, amount: String(-8_800_000) },
      { accountCode: '999', partyId: null, amount: String(1_000_000) },
    ]);
    expect(report.balanced).toBe(false);
  });

  it('reads each side of every TT133 account at most once', () => {
    const accounts = [
      '1111', '1112', '1121', '1122', '121', '128', '131', '1331', '1332', '1361', '1368', '1381', '1386', '1388', '141',
      '151', '152', '153', '154', '155', '156', '157', '211', '2141', '2142', '2143', '2147', '217', '228', '2291', '2292',
      '2293', '2294', '241', '242', '331', '3331', '3334', '3335', '3338', '3339', '334', '335', '3361', '3368', '3381', '3383',
      '3386', '3388', '341', '352', '353', '356', '4111', '4112', '4118', '413', '418', '419', '4211', '4212', '511', '515',
      '611', '631', '632', '635', '642', '711', '811', '821', '911',
    ];
    const j = new Journal();
    // Each account gets a debit and a credit that cancel out: no balances, but every account is present,
    // so buildB01 resolves its readers and throws on a side read twice or an inconsistent party grouping.
    for (const account of accounts) {
      j.post('2026-01-01', [[account, 1, 0], ['1121', 0, 1]]);
      j.post('2026-01-01', [['1121', 1, 0], [account, 0, 1]]);
    }
    const report = buildB01(j.entries, LE, '2026-12-31');
    expect(report.unmapped).toEqual([]);
    expect(report.lines.every((l) => l.amount === '0')).toBe(true);
  });

  it('refuses entries in another currency', () => {
    expect(() => buildB01([{ legalEntityId: LE, entryDate: '2026-01-01', currency: 'USD', reversal: false, lines: [] }], LE, '2026-12-31')).toThrow(/book currency/);
  });
  it('reports one legal entity, never the sum of several', () => {
    const sample = sampleYear();
    const other = new Journal('le-other');
    other.post('2026-01-02', [['1121', 7_000_000, 0], ['4111', 0, 7_000_000]]);
    const report = buildB01([...sample.entries, ...other.entries], LE, '2026-12-31');
    expect(amounts(report)).toEqual(asText(B01_YEAR_END));
    expect(amounts(buildB01(other.entries, 'le-other', '2026-12-31'))['411']).toBe('7000000');
  });
});

describe('TT133 B02-DNN (draft)', () => {
  it('matches the hand calculation for the year', () => {
    const report = buildB02(sampleYear().entries, LE, '2026-01-01', '2026-12-31');
    expect(amounts(report)).toEqual(asText(B02_YEAR));
    expect(report.unmapped).toEqual([]);
  });

  it('matches the hand calculation for the first quarter', () => {
    // 01 300M, 02 10M, 11 150M; 24: 6422 12 +40 (the wrong expense nets out) and 6421 3 = 55M.
    const report = buildB02(sampleYear().entries, LE, '2026-01-01', '2026-03-31');
    expect(amounts(report)).toEqual(asText({
      '01': 300_000_000, '02': 10_000_000, '10': 290_000_000, '11': 150_000_000, '20': 140_000_000, '21': 0, '22': 0, '23': 0, '24': 55_000_000,
      '30': 85_000_000, '31': 0, '32': 0, '40': 0, '50': 85_000_000, '51': 0, '60': 85_000_000,
    }));
  });

  it('leaves out the closing entries, so it is the same after the year is closed', () => {
    const j = sampleYear();
    closeYear(j);
    expect(amounts(buildB02(j.entries, LE, '2026-01-01', '2026-12-31'))).toEqual(asText(B02_YEAR));
  });

  it('reports activity on an account no line reads', () => {
    const j = sampleYear();
    j.post('2026-12-31', [['521', 1_000_000, 0], ['131', 0, 1_000_000, 'C1']]); // a TT200 account, not in TT133
    expect(buildB02(j.entries, LE, '2026-01-01', '2026-12-31').unmapped).toEqual([{ accountCode: '521', partyId: null, amount: String(1_000_000) }]);
  });

  it('agrees with B01: profit after tax equals the change in retained earnings', () => {
    const entries = sampleYear().entries;
    const b01 = amounts(buildB01(entries, LE, '2026-12-31'));
    const b02 = amounts(buildB02(entries, LE, '2026-01-01', '2026-12-31'));
    expect(b01['417']).toBe(b02['60']);
  });
});

// Sub-accounts of an org (#319) extend their parent's code, so the reports count them under the parent with no mapping.
describe('TT133 reports with sub-accounts (#319)', () => {
  // The sample year plus moves between 1121 and its sub-accounts 1121.VCB and 11212, and part of the office rent moved
  // to the cost center 6422.HCM.
  function withSubAccounts(): Journal {
    const j = sampleYear();
    j.post('2026-12-31', [['1121.VCB', 70_000_000, 0], ['1121', 0, 70_000_000]]); // a transfer between bank accounts
    j.post('2026-12-31', [['11212', 30_000_000, 0], ['1121.VCB', 0, 30_000_000]]);
    j.post('2026-12-31', [['6422.HCM', 4_000_000, 0], ['6422', 0, 4_000_000]]); // a reclassification to a cost center
    return j;
  }

  it('rolls sub-accounts up into their parent lines, so moves between them change nothing', () => {
    const report = buildB01(withSubAccounts().entries, LE, '2026-12-31');
    expect(amounts(report)).toEqual(asText(B01_YEAR_END));
    expect(report.unmapped).toEqual([]);
    expect(amounts(buildB02(withSubAccounts().entries, LE, '2026-01-01', '2026-12-31'))).toEqual(asText(B02_YEAR));
  });

  it('counts activity posted only on sub-accounts under the parent line', () => {
    const j = new Journal();
    j.post('2026-01-02', [['1121.VCB', 9_000_000, 0], ['4111', 0, 9_000_000]]);
    j.post('2026-01-03', [['6422.HCM', 2_000_000, 0], ['1121.VCB', 0, 2_000_000]]);
    const b01 = amounts(buildB01(j.entries, LE, '2026-12-31'));
    expect([b01['110'], b01['411'], b01['417']]).toEqual(['7000000', '9000000', '-2000000']);
    expect(amounts(buildB02(j.entries, LE, '2026-01-01', '2026-12-31'))['24']).toBe('2000000');
  });
});
