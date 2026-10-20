import { describe, expect, it } from 'vitest';
import { validateVariant } from '../src/domain/validate.ts';

describe('first comments (#587)', () => {
  const base = { body: 'Khai trương', title: null, media: [] };
  it('checks the comment against the channel limit, and refuses it where Crove posts none', () => {
    expect(validateVariant({ ...base, provider: 'x', settings: { firstComment: '#a #b' } })).toEqual([]);
    expect(validateVariant({ ...base, provider: 'x', settings: { firstComment: 'ệ'.repeat(141) } })).toEqual([{ code: 'COMMENT_TOO_LONG', field: 'settings.firstComment', limit: 280, actual: 282 }]);
    expect(validateVariant({ ...base, provider: 'facebook_page', settings: { firstComment: '#a' } }).map((i) => i.code)).toEqual(['COMMENT_NOT_SUPPORTED']);
    // A blank comment is no comment.
    expect(validateVariant({ ...base, provider: 'facebook_page', settings: { firstComment: '   ' } })).toEqual([]);
  });
});