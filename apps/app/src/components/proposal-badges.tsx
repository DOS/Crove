// SPDX-License-Identifier: AGPL-3.0-only
// The badges on a proposal's row in the Inbox lists (DESIGN.md §4.4): its kind, what its checks found, who asked for it,
// and, once a reversal voided its posting, that it is no longer in the books (#2054).
import { useTranslations } from 'use-intl';
import { JOURNAL_VOUCHER_KIND } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { REVERSAL_KIND } from '../lib/reversal.ts';
import { showMatched } from '../lib/review.ts';
import { VOUCHER_KIND } from '../lib/vouchers.ts';

// What the badges read of a list item (kernel.inbox.list).
export interface ProposalBadgesItem {
  kind: string;
  direction: 'sale' | 'purchase' | null;
  duplicateOf: string | null;
  signatureStatus: string | null;
  failedChecks: number;
  warnChecks: number;
  // Lines of an invoice proposal no rule matched (#2091); absent counts as none.
  unclassifiedLines?: number;
  requestedByAgent: { name: string } | null;
  extracted: boolean;
  voided: boolean;
}

export function ProposalBadges({ item }: { item: ProposalBadgesItem }) {
  const t = useTranslations('inbox');
  return (
    <div className="flex flex-wrap gap-1">
      {/* A posting a reversal voided is no longer in the books, whatever tab lists it: the chip the file and the proposal
          page give it. */}
      {item.voided && <Badge variant="destructive">{t('voided')}</Badge>}
      {/* A reversal a user asked for has no invoice checks; its card shows the entry it reverses. */}
      {item.kind === REVERSAL_KIND && <Badge variant="secondary">{t('reversalKind')}</Badge>}
      {item.kind === VOUCHER_KIND && <Badge variant="secondary">{t('voucherKind')}</Badge>}
      {item.kind === JOURNAL_VOUCHER_KIND && <Badge variant="secondary">{t('journalVoucherKind')}</Badge>}
      {item.direction === 'sale' && <Badge variant="secondary">{t('saleKind')}</Badge>}
      {item.duplicateOf && <Badge variant="warning">{t('maybeDuplicate')}</Badge>}
      {item.signatureStatus === 'unverified' && <Badge variant="destructive">{t('signatureUnverified')}</Badge>}
      {(item.unclassifiedLines ?? 0) > 0 && <Badge variant="warning">{t('unclassifiedBadge', { count: item.unclassifiedLines ?? 0 })}</Badge>}
      {item.failedChecks > 0 && <Badge variant="destructive">{t('failedChecks', { count: item.failedChecks })}</Badge>}
      {item.warnChecks > 0 && <Badge variant="warning">{t('warnChecks', { count: item.warnChecks })}</Badge>}
      {item.requestedByAgent && <Badge variant="proposal">{t('agentProposed', { name: item.requestedByAgent.name })}</Badge>}
      {showMatched(item, REVERSAL_KIND, VOUCHER_KIND, JOURNAL_VOUCHER_KIND) && <Badge variant="success">{t('matched')}</Badge>}
    </div>
  );
}
