import { Link, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { StatusLink } from '../components/status-link.tsx';
import { SupportLink } from '../components/support-link.tsx';
import { PageHeader } from '../components/ui.tsx';
import { getConfig } from '../lib/auth.ts';
import { FIRM_GUIDE } from '../lib/firm-guide.ts';
import { QUICK_GUIDE } from '../lib/quick-guide.ts';
import { supportLink } from '../lib/support.ts';

// The one-page quick guide (issue #310), then the guide for an accounting firm (#661). Their steps are Vietnamese in
// every interface language (see quick-guide.ts and firm-guide.ts).
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
      {/* A section of the same page: an h2, so the page keeps one h1. */}
      <div className="mt-10 mb-6">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{t('firmTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('firmSubtitle')}</p>
      </div>
      <div lang="vi" className="grid max-w-3xl gap-4">
        {FIRM_GUIDE.map((step) => (
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
      {getConfig().statusPage && (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('statusHint')} <StatusLink className="text-link hover:underline" />.
        </p>
      )}
    </>
  );
}
