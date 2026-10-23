// The same text going out again on a channel (#1156): social.post.get names the newest other post on the channel with
// the same text (published in the last 30 days, scheduled or queued). X and LinkedIn refuse such a post, so there the
// note says it will be refused; elsewhere it is advice, since followers see the same text twice. A link takes the
// member to the AI rewrite (#583) of the text the channel sends, when they may use it.
import { useTranslations } from 'use-intl';
import { refusesDuplicates, type DuplicateOf } from '@crove/mod-social/contract';
import { useFormat } from '../i18n/provider.tsx';
import { providerName } from '../lib/social.ts';

// The ids of the AI rewrite boxes: the shared text's, and a channel's own text's.
export const SHARED_REWRITE_ID = 'social-rewrite';
export const ownRewriteId = (connectionId: string) => `social-rewrite-${connectionId}`;

// Brings an AI rewrite box into view and puts the focus on its choice of rewrite.
function goToRewrite(id: string) {
  const box = document.getElementById(id);
  if (!box) return;
  box.scrollIntoView({ block: 'center' });
  box.querySelector<HTMLElement>('select, button')?.focus();
}

export function DuplicateNote({ provider, of, channel, rewriteTarget }: { provider: string; of: DuplicateOf; channel?: string; rewriteTarget: string | null }) {
  const t = useTranslations('social.sameText');
  const f = useFormat();
  const refused = refusesDuplicates(provider);
  const text = t(refused ? 'refused' : 'advice', { platform: providerName(provider), status: of.status, when: of.at ? f.dateTime(of.at) : '' });
  return (
    <div className={refused ? 'space-y-1 text-sm text-destructive' : 'space-y-1 text-sm text-warning'}>
      <p>{channel ? `${channel}: ${text}` : text}</p>
      {rewriteTarget && (
        <button type="button" className="text-link hover:underline" onClick={() => goToRewrite(rewriteTarget)}>
          {t('rewrite')}
        </button>
      )}
    </div>
  );
}
