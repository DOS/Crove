// SPDX-License-Identifier: AGPL-3.0-only
// One chip per state (DESIGN.md §4.4, #2000): every proposal status has its chip and its words in both languages, and a
// proposal waiting for a person is shown in the proposal hue, never the success green of work that is done.
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { FILE_STATE_VARIANT, PROPOSAL_STATUSES, PROPOSAL_STATUS_VARIANT, fileChipVariant, fileProposal } from '../src/lib/status.ts';

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

  it("shows a proposed file as its proposal: waiting, posted or rejected (#2009)", () => {
    expect(fileChipVariant('proposed', 'pending')).toBe('proposal');
    expect(fileChipVariant('proposed', 'executed')).toBe('success');
    expect(fileChipVariant('proposed', 'rejected')).toBe(PROPOSAL_STATUS_VARIANT.rejected);
    for (const status of PROPOSAL_STATUSES) expect(fileChipVariant('proposed', status)).toBe(PROPOSAL_STATUS_VARIANT[status]);
    // A posted file never looks like one still waiting.
    expect(fileChipVariant('proposed', 'executed')).not.toBe(fileChipVariant('proposed', 'pending'));
    // Without its proposal's status, and in any other state, a file keeps its own chip.
    expect(fileChipVariant('proposed', null)).toBe(FILE_STATE_VARIANT.proposed);
    expect(fileChipVariant('duplicate', 'pending')).toBe(FILE_STATE_VARIANT.duplicate);
    expect(fileProposal('failed', 'rejected')).toBeNull();
  });

  it('shows a voided posting as voided, in the error chip, never as posted (#2032)', () => {
    expect(fileProposal('proposed', 'executed', true)).toBe('voided');
    expect(fileChipVariant('proposed', 'executed', true)).toBe('destructive');
    expect(fileChipVariant('proposed', 'executed', true)).not.toBe(fileChipVariant('proposed', 'executed'));
    // Only a posting is voided: the flag says nothing about a proposal that was not posted.
    expect(fileProposal('proposed', 'pending', true)).toBe('pending');
    expect(vi.inbox.fileStatus.voided).toMatch(/\S/);
    expect(en.inbox.fileStatus.voided).toMatch(/\S/);
  });
});
