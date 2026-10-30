// The register of fixed assets and prepaid costs (#919): the form's defaults and checks, the months offered for a
// depreciation and the label of a month. The kernel decides every rule again (modules/finance/src/fixed-assets.ts);
// these only spare a round trip.
import type { FixedAssetCreate } from '@crove/kernel-contract';
import { normalizeAmount } from './vouchers.ts';

export type FixedAssetKind = FixedAssetCreate['kind'];

export interface FixedAssetForm {
  kind: FixedAssetKind;
  name: string;
  cost: string;
  assetAccount: string;
  accumulatedAccount: string;
  expenseAccount: string;
  startMonth: string;
  months: string;
}

export type FixedAssetFormProblem = 'name' | 'cost' | 'accounts' | 'startMonth' | 'months';

// The usual accounts of each kind under TT133: a machine on 2111 depreciated through 2141, a prepaid cost on 242;
// both to general and administrative expenses (6422) until the user picks another.
export function defaultAccounts(kind: FixedAssetKind): Pick<FixedAssetForm, 'assetAccount' | 'accumulatedAccount' | 'expenseAccount'> {
  return kind === 'fixed_asset'
    ? { assetAccount: '2111', accumulatedAccount: '2141', expenseAccount: '6422' }
    : { assetAccount: '242', accumulatedAccount: '', expenseAccount: '6422' };
}

const MONTH = /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/;
const WHOLE = /^\d{1,15}$/;

function accountsFit(form: FixedAssetForm): boolean {
  const { kind, assetAccount: a, accumulatedAccount: acc, expenseAccount: e } = form;
  const expense = /^[68]/.test(e) || e.startsWith('154');
  if (kind === 'fixed_asset') return (a.startsWith('211') || a.startsWith('213')) && acc.startsWith('214') && expense;
  return a.startsWith('242') && acc.trim() === '' && expense;
}

// The form's checks in the order it shows the fields; each problem sits under its field (DESIGN.md §4.2, #2004), the
// accounts' under the last account field.
export const FIXED_ASSET_FORM_FIELDS: readonly FixedAssetFormProblem[] = ['name', 'cost', 'accounts', 'startMonth', 'months'];

export function fixedAssetFieldProblem(form: FixedAssetForm, field: FixedAssetFormProblem): boolean {
  switch (field) {
    case 'name':
      return form.name.trim() === '';
    case 'cost': {
      const cost = normalizeAmount(form.cost);
      return !WHOLE.test(cost) || !/[1-9]/.test(cost);
    }
    case 'accounts':
      return !accountsFit(form);
    case 'startMonth':
      return !MONTH.test(form.startMonth);
    case 'months': {
      const months = Number(form.months);
      return !/^\d{1,3}$/.test(form.months.trim()) || months < 1 || months > 600;
    }
  }
}

// The first problem of the form, or null when it can be sent.
export function fixedAssetFormProblem(form: FixedAssetForm): FixedAssetFormProblem | null {
  return FIXED_ASSET_FORM_FIELDS.find((field) => fixedAssetFieldProblem(form, field)) ?? null;
}

// The input of finance.fixed_asset.create for a form without a problem.
export function fixedAssetInput(form: FixedAssetForm): FixedAssetCreate {
  return {
    kind: form.kind,
    name: form.name.trim(),
    cost: normalizeAmount(form.cost),
    assetAccount: form.assetAccount.trim(),
    accumulatedAccount: form.kind === 'fixed_asset' ? form.accumulatedAccount.trim() : null,
    expenseAccount: form.expenseAccount.trim(),
    startMonth: form.startMonth,
    months: Number(form.months),
  };
}

// 'YYYY-MM' of a 'YYYY-MM-DD' date, and the month before it: a month is depreciated once it has ended, so the one
// before today is offered first.
export function previousMonth(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// The last twelve months up to the given one, newest first.
export function recentMonths(last: string, count = 12): string[] {
  const out: string[] = [];
  let y = Number(last.slice(0, 4));
  let m = Number(last.slice(5, 7));
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

// MM/YYYY, as Vietnamese books write a month.
export function monthLabel(month: string): string {
  return `${month.slice(5, 7)}/${month.slice(0, 4)}`;
}
