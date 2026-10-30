// SPDX-License-Identifier: AGPL-3.0-only
// One chip per state (DESIGN.md §4.4, #2000): small, text plus a semantic color, and the same state looks the same on
// every screen. A proposal waiting for a person has the proposal hue (DESIGN.md §2), never the success green of work
// that is done.
import { zProposalStatus } from '@crove/kernel-contract';

export type ChipVariant = 'secondary' | 'brand' | 'success' | 'warning' | 'destructive' | 'proposal';
export type ProposalStatus = (typeof zProposalStatus.options)[number];

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = zProposalStatus.options;

// A proposal's status (kernel.proposal): its chip; the label is inboxDetail.status.<status> in the catalogs.
export const PROPOSAL_STATUS_VARIANT: Record<ProposalStatus, ChipVariant> = {
  pending: 'proposal',
  approved: 'brand',
  executed: 'success',
  rejected: 'secondary',
  failed: 'destructive',
  expired: 'warning',
};

// A file on its way to a proposal (the Inbox's files and the intake list): one map, so a state looks the same on both.
// `proposed` is shown by its proposal's status (fileProposal, #2009); its own chip is the fallback for a file whose
// proposal's status is not known. `rejected` is an archive entry that was not filed (encrypted, corrupt, too large): an
// error, not a rejected proposal.
export const FILE_STATE_VARIANT = {
  queued: 'secondary',
  uploading: 'brand',
  upload_failed: 'destructive',
  processing: 'brand',
  waiting: 'warning',
  proposed: 'success',
  duplicate: 'warning',
  failed: 'destructive',
  expanded: 'success',
  rejected: 'destructive',
} as const satisfies Record<string, ChipVariant>;
export type FileState = keyof typeof FILE_STATE_VARIANT;

// The proposal a file's chip shows (#2009): a proposed file looks as its proposal does, waiting for a person in the
// proposal hue, posted in success, rejected as a rejected proposal (DESIGN.md principle 2). Null for any other state,
// which keeps its file chip.
export function fileProposal(state: string, proposalStatus: ProposalStatus | null): ProposalStatus | null {
  return state === 'proposed' ? proposalStatus : null;
}

export function fileChipVariant(state: FileState, proposalStatus: ProposalStatus | null): ChipVariant {
  const proposal = fileProposal(state, proposalStatus);
  return proposal ? PROPOSAL_STATUS_VARIANT[proposal] : FILE_STATE_VARIANT[state];
}
