// SPDX-License-Identifier: AGPL-3.0-only
// One chip per state (DESIGN.md §4.4, #2000): every proposal status has its chip and its words in both languages, and a
// proposal waiting for a person is shown in the proposal hue, never the success green of work that is done.
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { FILE_STATE_VARIANT, PROPOSAL_STATUSES, PROPOSAL_STATUS_VARIANT } from '../src/lib/status.ts';

describe('status chips', () => {
  it('gives every proposal status a chip and a label in Vietnamese and English', () => {
    expect([...PROPOSAL_STATUSES].sort()).toEqual(Object.keys(PROPOSAL_STATUS_VARIANT).sort());
    for (const status of PROPOSAL_STATUSES) {
      expect(vi.inboxDetail.status[status], `vi ${status}`).toMatch(/\S/);
      expect(en.inboxDetail.status[status], `en ${status}`).toMatch(/\S/);
      // Words, never the status code itself.
      expect(vi.inboxDetail.status[status]).not.toBe(status);
      expect(en.inboxDetail.status[status]).not.toBe(status);
    }
  });

  it('shows a proposal waiting for a person in the proposal hue, and an error in the error chip', () => {
    expect(PROPOSAL_STATUS_VARIANT.pending).toBe('proposal');
    expect(PROPOSAL_STATUS_VARIANT.executed).toBe('success');
    expect(PROPOSAL_STATUS_VARIANT.failed).toBe('destructive');
    // Files: an archive entry not filed and a file not read are errors.
    expect(FILE_STATE_VARIANT.rejected).toBe('destructive');
    expect(FILE_STATE_VARIANT.failed).toBe('destructive');
  });
});
