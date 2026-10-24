// The personal-data registry's per-row handling (#1312): a legal entity the org keeps books for (a client, a household
// whose name and 12-digit code are a person's) is kept by law, and only the org's default entity is the org's own.
import { describe, expect, it } from 'vitest';
import { PERSONAL_DATA_COLUMNS, personalDataProbe, rowHandling, type PersonalDataColumn } from '@crove/kernel';

const entries = PERSONAL_DATA_COLUMNS as Record<string, PersonalDataColumn>;

describe('personal-data registry: legal entities (#1312)', () => {
  it('registers the name and the tax code of a legal entity, kept by law', () => {
    expect(entries['crove_kernel.legal_entity.name']).toMatchObject({ kind: 'name', handling: 'keep_legal' });
    expect(entries['crove_kernel.legal_entity.tax_code']).toMatchObject({ kind: 'tax_code', handling: 'keep_legal' });
  });

  it("keeps a non-default entity by law and the default one as the org's own", () => {
    for (const key of ['crove_kernel.legal_entity.name', 'crove_kernel.legal_entity.tax_code']) {
      const entry = entries[key] as PersonalDataColumn;
      expect(rowHandling(entry, { kind: 'household', is_default: false }), key).toEqual({ handling: 'keep_legal', reason: entry.reason });
      expect(rowHandling(entry, { kind: 'household', is_default: true }).handling, key).toBe('keep_org');
      // Anything but a true flag keeps the column's own handling.
      expect(rowHandling(entry, { is_default: 'true' }).handling, key).toBe('keep_legal');
      expect(rowHandling(entry, {}).handling, key).toBe('keep_legal');
    }
  });

  it('leaves columns without an override as they are', () => {
    const tenantCode = entries['crove_kernel.tenant.tax_code'] as PersonalDataColumn;
    expect(rowHandling(tenantCode, { is_default: true })).toEqual({ handling: 'keep_org', reason: tenantCode.reason });
    const partyEmail = entries['crove_kernel.party.email'] as PersonalDataColumn;
    expect(rowHandling(partyEmail, { is_default: true }).handling).toBe('erase');
  });

  it('finds a household by its 12-digit national ID number', () => {
    expect(personalDataProbe('0790 9100 1234')).toEqual({ kind: 'digits', digits: '079091001234' });
  });
});
