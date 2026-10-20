import { describe, expect, it } from 'vitest';
import { noteOf, prNumbers, releaseNotes } from '../release-notes.mjs';

describe('noteOf', () => {
  it('reads the note line in its usual forms', () => {
    expect(noteOf('Closes #1\n\nRelease note (vi): Xuất phiếu thu sang MISA.\n')).toBe('Xuất phiếu thu sang MISA.');
    expect(noteOf('**Release note (vi):** Tải hóa đơn bằng email.')).toBe('Tải hóa đơn bằng email.');
    expect(noteOf('- release note (vi):   Sửa   lỗi  chi nhánh ')).toBe('Sửa lỗi chi nhánh');
  });

  it('treats a missing, empty or "none" note as internal', () => {
    expect(noteOf(null)).toBeNull();
    expect(noteOf('Closes #1\n\nNo note here.')).toBeNull();
    expect(noteOf('Release note (vi):')).toBeNull();
    expect(noteOf('Release note (vi): <!-- one line for the partner, or leave empty -->')).toBeNull();
    expect(noteOf('Release note (vi): -')).toBeNull();
    expect(noteOf('Release note (vi): Không.')).toBeNull();
    expect(noteOf('Release note (vi): none')).toBeNull();
  });

  it('keeps one line and bounds its length', () => {
    expect(noteOf('Release note (vi): Dòng một\nDòng hai')).toBe('Dòng một');
    expect(noteOf(`Release note (vi): ${'a'.repeat(400)}`)).toHaveLength(300);
  });
});

describe('prNumbers', () => {
  it('takes the trailing PR number of squash merges, oldest first, once each', () => {
    const subjects = [
      'feat(app): a guide for accounting firms (#661) (#663)',
      'Merge branch main',
      'fix(finance): branch codes (#698)',
      'fix(finance): branch codes (#698)',
    ];
    expect(prNumbers(subjects)).toEqual([698, 663]);
  });
});

describe('releaseNotes', () => {
  const bodies: Record<number, string | null> = {
    663: 'Release note (vi): Hướng dẫn cho công ty dịch vụ kế toán.',
    698: 'Release note (vi):',
    700: null,
  };

  it('lists the notes with their PR, and skips PRs without one', () => {
    const md = releaseNotes({
      tag: 'v0.2.0',
      subjects: ['chore: settings (#700)', 'fix: codes (#698)', 'feat: guide (#661) (#663)'],
      body: (pr) => bodies[pr] ?? null,
    });
    expect(md).toBe('## Có gì mới trong v0.2.0\n\n- Hướng dẫn cho công ty dịch vụ kế toán. (#663)\n');
  });

  it('says so when nothing in the release is for the partner', () => {
    const md = releaseNotes({ tag: 'v0.2.1', subjects: ['chore: settings (#700)'], body: () => null });
    expect(md).toBe('## Có gì mới trong v0.2.1\n\nBản này không có thay đổi nào bạn cần biết.\n');
  });
});
