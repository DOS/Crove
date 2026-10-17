import { Link, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { SupportLink } from '../components/support-link.tsx';
import { PageHeader } from '../components/ui.tsx';
import { getConfig } from '../lib/auth.ts';
import { QUICK_GUIDE } from '../lib/quick-guide.ts';
import { supportLink } from '../lib/support.ts';

// The one-page quick guide (issue #310). Its steps are Vietnamese in every interface language (see quick-guide.ts).
export function GuidePage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('guide');
  const back = useTranslations('inboxDetail');
  const hasSupport = supportLink(getConfig().supportUrl) !== null;

  return (
    <>
      <Link to="/o/$slug/inbox" params={{ slug }} className="text-sm text-muted-foreground hover:text-foreground">
        {back('back')}
      </Link>
      <div className="mt-3">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
      </div>
      <div lang="vi" className="grid max-w-3xl gap-4">
        {QUICK_GUIDE.map((step) => (
          <Card key={step.id} className="block p-5">
            <h2 className="text-base font-semibold text-foreground">{step.title}</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              {step.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </Card>
        ))}
      </div>
      {hasSupport && (
        <p className="mt-6 text-sm text-muted-foreground">
          {t('supportHint')} <SupportLink className="text-link hover:underline" />.
        </p>
      )}
    </>
  );
}
