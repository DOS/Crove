// The audit log screen's filter (#672).
import { describe, expect, it } from 'vitest';
import { auditFilter, nextAuditCursor } from '../src/lib/audit.ts';

const empty = { actor: '', command: '', outcome: '', target: '', from: '', to: '' };

describe('audit filter', () => {
  it('sends only what the server accepts', () => {
    expect(auditFilter(empty)).toEqual({});
    expect(auditFilter({ ...empty, actor: 'system', command: 'kernel.org.set_address', outcome: 'denied', from: '2026-10-01', to: '2026-10-31' })).toEqual({
      actor: 'system',
      command: 'kernel.org.set_address',
      outcome: 'denied',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(auditFilter({ ...empty, target: ' 0192F0AA-1111-7222-8333-944445555666 ' })).toEqual({ targetId: '0192f0aa-1111-7222-8333-944445555666' });
    expect(auditFilter({ ...empty, target: '0192f0aa', outcome: 'maybe', from: '1/10/2026' })).toEqual({});
  });

  it('pages after the last row while more follow', () => {
    const item = { id: 'b', at: '2026-10-01T00:00:00.000Z' } as never;
    expect(nextAuditCursor({ items: [item], more: true })).toEqual({ at: '2026-10-01T00:00:00.000Z', id: 'b' });
    expect(nextAuditCursor({ items: [item], more: false })).toBeUndefined();
    expect(nextAuditCursor({ items: [], more: true })).toBeUndefined();
  });
});
