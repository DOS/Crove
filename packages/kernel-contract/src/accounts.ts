// Sub-account codes under the TT133 chart (issue #319), as pure functions shared by the finance commands and the
// SPA. The database applies the same rules (crove_finance.org_account_before_insert); these give a precise message
// first.
//
// A sub-account's code extends its parent's code, the way Vietnamese firms number their detail accounts:
// - with digits: 11211 under 1121, 64221 under 6422;
// - with a dot and a short upper-case tag: 1121.VCB (a bank), 6422.HCM (a cost center).
// A tagged account has no sub-accounts of its own. Because every code starts with its parent's code, a report that
// reads accounts by code prefix (B01-DNN, B02-DNN) counts a sub-account under its TT133 parent, and the sub-account
// takes that parent's type and normal balance.

// Any account code Crove accepts: a TT133 code (3 to 5 digits), a digit sub-account (up to 10 digits) or a tagged one.
export const ACCOUNT_CODE_PATTERN = /^[0-9]{3,10}(\.[A-Z0-9]{1,20})?$/;
const SUFFIX_PATTERN = /^([0-9]{1,5}|\.[A-Z0-9]{1,20})$/;

export type SubAccountCodeProblem = 'format' | 'not_under_parent' | 'parent_tagged';

// Why `code` cannot be a sub-account of `parentCode`, or null when it can (whether both exist is the caller's check).
export function subAccountCodeProblem(parentCode: string, code: string): SubAccountCodeProblem | null {
  if (!ACCOUNT_CODE_PATTERN.test(code) || !ACCOUNT_CODE_PATTERN.test(parentCode)) return 'format';
  if (isTaggedCode(parentCode)) return 'parent_tagged';
  if (!code.startsWith(parentCode) || !SUFFIX_PATTERN.test(code.slice(parentCode.length))) return 'not_under_parent';
  return null;
}

export function isTaggedCode(code: string): boolean {
  return code.includes('.');
}

// The accounts a sale line may be credited to, and a purchase line never debited to (#430): every TT133 account of
// class 5 (511 sales, 515 financial income), 711 other income and 3387 unearned revenue, with their sub-accounts (a
// sub-account's code starts with its parent's). The database holds every writer to the same rule
// (crove_finance.check_line_direction).
export function isRevenueAccount(code: string): boolean {
  return /^(5|711|3387)/.test(code);
}

// The code a user typed, as stored: trimmed, the tag in upper case (1121.vcb is 1121.VCB).
export function normalizeAccountCode(input: string): string {
  return input.trim().toUpperCase();
}
