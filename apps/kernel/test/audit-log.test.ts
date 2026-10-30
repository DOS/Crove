// The audit log's display rules (#672): which detail keys are hidden, how a detail reads on one line, and CSV cells.
import { describe, expect, it } from 'vitest';
import { auditCsv, auditDetailLine, csvCell, hiddenKey } from '@crove/kernel';

describe('audit detail', () => {
  it('hides keys that name a secret, by word', () => {
    for (const k of ['token', 'accessToken', 'refresh_token', 'apiKey', 'key_id', 'from_key_id', 'manifest_key', 'sessionId', 'input_sha256', 'password', 'sealed', 'signature', 'iv', 'credentials']) {
      expect(hiddenKey(k), k).toBe(true);
    }
    for (const k of ['provider', 'shared', 'keyword', 'monkey', 'archive', 'role', 'aal', 'code', 'rows', 'invite_id', 'eligible_approvers']) {
      expect(hiddenKey(k), k).toBe(false);
    }
  });

  it('reads as key=value pairs, nested with dots, cut and cleaned', () => {
    expect(auditDetailLine({})).toBeNull();
    expect(auditDetailLine(null)).toBeNull();
    expect(auditDetailLine({ role: 'admin', previous: { role: 'member' }, ids: ['a', 'b'] })).toBe('role=admin; previous.role=member; ids=[a, b]');
    expect(auditDetailLine('{"provider":"x","token":"t"}')).toBe('provider=x; token=[ẩn]');
    expect(auditDetailLine({ note: 'a\nb\u0000c' })).toBe('note=a b c');
    expect(auditDetailLine({ notes: ['a\nb', 'z'.repeat(250)] })).toBe(`notes=[a b, ${'z'.repeat(200)}…]`);
    expect(auditDetailLine({ deep: { a: { b: { c: { d: 1 } } } } })).toBe('deep.a.b={…}');
    // The worker process a system row names is never shown to the org (#1951).
    expect(auditDetailLine({ workerInstance: 'crove-worker:host-a' })).toBeNull();
    expect(auditDetailLine('{"workerInstance":"crove-worker:host-a","rows":3}')).toBe('rows=3');
    expect(auditDetailLine({ list: Array.from({ length: 12 }, (_, i) => i) })).toBe('list=[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, … (12)]');
    expect([...(auditDetailLine({ text: 'x'.repeat(5000) }) ?? '')].length).toBeLessThanOrEqual(206);
    const long = auditDetailLine(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'y'.repeat(100)])));
    expect([...(long ?? '')].length).toBe(1001);
  });
});

describe('audit CSV', () => {
  it('keeps formulas as text and quotes what needs it', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+84 90')).toBe("'+84 90");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("u","x")')).toBe(`"'=HYPERLINK(""u"",""x"")"`);
  });

  it('writes a UTF-8 marked file with CRLF lines', () => {
    const csv = auditCsv([
      { id: 'i', at: '2026-10-01T03:00:00.000Z', actorType: 'user', actorId: null, actorName: 'Lê Văn A', command: 'kernel.org.set_address', outcome: 'ok', targetType: null, targetId: null, proposalId: null, detail: 'a=1' },
    ]);
    expect(csv.startsWith('﻿occurred_at,')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')[1]).toBe('2026-10-01T03:00:00.000Z,user,,Lê Văn A,kernel.org.set_address,ok,,,,a=1');
  });
});
