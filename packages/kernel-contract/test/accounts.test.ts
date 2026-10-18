// Sub-account codes under the TT133 chart (#319): the shape rules the commands, the screen and the database share.
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CODE_PATTERN, isRevenueAccount, isTaggedCode, normalizeAccountCode, subAccountCodeProblem, zAccountCode } from '../src/index.ts';

describe('sub-account codes', () => {
  it('accepts a code that extends its parent with digits or a dot and a tag', () => {
    expect(subAccountCodeProblem('112', '1121')).toBeNull();
    expect(subAccountCodeProblem('1121', '11211')).toBeNull();
    expect(subAccountCodeProblem('1121', '1121.VCB')).toBeNull();
    expect(subAccountCodeProblem('6422', '6422.HCM01')).toBeNull();
  });

  it('refuses a code that does not start with its parent, or adds too much', () => {
    expect(subAccountCodeProblem('112', '1131')).toBe('not_under_parent');
    expect(subAccountCodeProblem('112', '112')).toBe('not_under_parent');
    expect(subAccountCodeProblem('112', '1121.VCB')).toBe('not_under_parent');
    expect(subAccountCodeProblem('112', '112123456')).toBe('not_under_parent');
  });

  it('gives a tagged account no sub-accounts, and refuses malformed codes', () => {
    expect(subAccountCodeProblem('1121.VCB', '1121.VCB1')).toBe('parent_tagged');
    expect(subAccountCodeProblem('112', '112.vcb')).toBe('format');
    expect(subAccountCodeProblem('112', '112.')).toBe('format');
    expect(subAccountCodeProblem('112', '112.VCB-1')).toBe('format');
    expect(subAccountCodeProblem('11', '111')).toBe('format');
  });

  it('normalizes what a user types and tells tagged codes apart', () => {
    expect(normalizeAccountCode(' 1121.vcb ')).toBe('1121.VCB');
    expect(isTaggedCode('1121.VCB')).toBe(true);
    expect(isTaggedCode('11211')).toBe(false);
  });

  it('accepts TT133 codes and sub-account codes on the wire, nothing else', () => {
    for (const ok of ['111', '6422', '33311', '1121.VCB', '112112345', '6422.A1B2C3']) expect(zAccountCode.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['11', '1121.vcb', '1121.', '.VCB', '1121.VCB.01', '11211234567', '6422 ', '6422.ABCDEFGHIJKLMNOPQRSTU']) {
      expect(zAccountCode.safeParse(bad).success, bad).toBe(false);
    }
    expect(ACCOUNT_CODE_PATTERN.test('1121.VCB')).toBe(true);
  });
});

describe('revenue accounts (#430)', () => {
  it('takes class 5, 711 and 3387 with their sub-accounts, and nothing else', () => {
    for (const code of ['511', '5111', '5113', '511.DV', '515', '711', '7111', '3387', '3387.TT']) expect(isRevenueAccount(code), code).toBe(true);
    for (const code of ['131', '331', '3331', '33311', '338', '3388', '642', '6422.VPP', '632', '811', '911']) expect(isRevenueAccount(code), code).toBe(false);
  });
});
