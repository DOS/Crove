// Captions from file names and the file's own issues, for drafts made from library files (#1080).
import { describe, expect, it } from 'vitest';
import { captionFromFilename, fileIssues, validateVariant } from '../src/index.ts';

describe('captionFromFilename', () => {
  it('drops the folder and extension, and reads underscores and runs of spaces as one space', () => {
    expect(captionFromFilename('ra_mat__san-pham.JPG')).toBe('ra mat san-pham');
    expect(captionFromFilename('C:\\Thiết kế\\Bộ ảnh  Tết.png')).toBe('Bộ ảnh Tết');
    expect(captionFromFilename('khai-truong.mp4')).toBe('khai-truong');
  });

  it('keeps a name that is only an extension, and one without any', () => {
    expect(captionFromFilename('.jpg')).toBe('.jpg');
    expect(captionFromFilename('poster')).toBe('poster');
  });

  it('writes Vietnamese in one form whatever the file system gave', () => {
    expect(captionFromFilename('Te\u0302\u0301t.jpg')).toBe('Tết');
  });
});

describe('fileIssues', () => {
  it("keeps the issues about the file and leaves the text and title to the draft's writer", () => {
    const issues = validateVariant({ provider: 'zalo_oa', body: '', title: null, media: [{ kind: 'video', mime: 'video/mp4', sizeBytes: 1000, durationSeconds: 5 }] });
    expect(issues.map((i) => i.code)).toContain('TITLE_REQUIRED');
    expect(fileIssues(issues).map((i) => [i.code, i.field])).toEqual([['MEDIA_KIND_NOT_ALLOWED', 'media.0']]);
  });
});
