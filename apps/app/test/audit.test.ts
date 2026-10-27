// The audit log screen's filter (#672) and its command labels (#1654).
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { auditFilter, commandLabel, nextAuditCursor, withCommandLabels } from '../src/lib/audit.ts';

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

  it('labels a command in each language, and gives null for a name without a label', () => {
    expect(commandLabel(vi.commands, 'kernel.proposal.approve')).toBe('Duyệt đề xuất');
    expect(commandLabel(en.commands, 'kernel.proposal.approve')).toBe('Approve a proposal');
    expect(commandLabel(vi.commands, 'kernel.proposal.gone')).toBeNull();
    expect(commandLabel(vi.commands, 'kernel.proposal')).toBeNull();
    expect(commandLabel(vi.commands, 'kernel.proposal.approve.more')).toBeNull();
    expect(commandLabel(vi.commands, 'kernel.toString')).toBeNull();
  });

  it('adds a label column after the command column and keeps every other cell as written', () => {
    const csv =
      '﻿occurred_at,actor_name,command,outcome,detail\r\n' +
      '2026-10-01T00:00:00.000Z,"Lê, Văn A",kernel.proposal.approve,ok,"a ""quoted"", line\r\nand more"\r\n' +
      "2026-10-02T00:00:00.000Z,'=1+1,kernel.retired,failed,\r\n";
    const labels = (name: string) => (name === 'kernel.proposal.approve' ? 'Duyệt, "nhanh"' : null);
    expect(withCommandLabels(csv, labels)).toBe(
      '﻿occurred_at,actor_name,command,command_label,outcome,detail\r\n' +
        '2026-10-01T00:00:00.000Z,"Lê, Văn A",kernel.proposal.approve,"Duyệt, ""nhanh""",ok,"a ""quoted"", line\r\nand more"\r\n' +
        "2026-10-02T00:00:00.000Z,'=1+1,kernel.retired,,failed,\r\n",
    );
    expect(withCommandLabels('a,b\r\n1,2\r\n', labels)).toBe('a,b\r\n1,2\r\n');
  });
});
