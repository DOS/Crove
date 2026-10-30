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

// A file on its way to a proposal (the Inbox's files and the intake list): the same words, the same chips. A file whose
// proposal waits is in the proposal hue, and one whose proposal was rejected is grey, as the proposal itself.
export const FILE_STATE_VARIANT = {
  queued: 'secondary',
  uploading: 'brand',
  upload_failed: 'destructive',
  processing: 'brand',
  waiting: 'warning',
  proposed: 'proposal',
  duplicate: 'warning',
  failed: 'destructive',
  expanded: 'success',
  rejected: 'secondary',
} as const satisfies Record<string, ChipVariant>;
export type FileState = keyof typeof FILE_STATE_VARIANT;
