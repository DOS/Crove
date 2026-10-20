import { describe, expect, it } from 'vitest';
import type { Runtime } from '@crove/kernel-runtime';
import { reviewAnswer, reviewView } from '../src/review-link.ts';

// The input checks run before any database call: this runtime fails the test if one is made.
const untouched = { orgless: () => Promise.reject(new Error('the database was called')) } as unknown as Runtime;
const token = 'A'.repeat(43);

describe('the public review routes refuse bad input before the database (#589)', () => {
  it('answers a malformed view request like an unknown link', async () => {
    await expect(reviewView(untouched, null)).resolves.toBeNull();
    await expect(reviewView(untouched, { token: 'short' })).resolves.toBeNull();
    await expect(reviewView(untouched, { token, extra: 1 })).resolves.toBeNull();
  });

  it('refuses an answer without a name, a comment without text, and text PostgreSQL cannot hold', async () => {
    await expect(reviewAnswer(untouched, { token: 'short', name: 'Lan', verdict: 'approved' })).resolves.toBeNull();
    await expect(reviewAnswer(untouched, { token, name: '  ', verdict: 'approved' })).rejects.toMatchObject({ code: 'REVIEW_ANSWER_INVALID', status: 422 });
    await expect(reviewAnswer(untouched, { token, name: 'Lan', verdict: 'comment', body: '   ' })).rejects.toMatchObject({ code: 'REVIEW_ANSWER_INVALID' });
    await expect(reviewAnswer(untouched, { token, name: 'Lan\u0000', verdict: 'approved' })).rejects.toMatchObject({ code: 'REVIEW_ANSWER_INVALID' });
    await expect(reviewAnswer(untouched, { token, name: 'Lan', verdict: 'publish' })).rejects.toMatchObject({ code: 'REVIEW_ANSWER_INVALID' });
  });
});