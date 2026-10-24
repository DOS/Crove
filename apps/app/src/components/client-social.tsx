// A client's Social figures on the multi-client home (#1261): what needs a person, what waits for review or for the
// client, the next 7 days and the last post, each a link to the list of that org's Social screens that shows it. The
// server reads them in the org as the member, so a member limited to some channels (#1081) sees their channels' only.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { cn } from '@crove/ui/lib/utils';
import { daysSince, socialFigures, type SocialFigure, type SocialFigures } from '../lib/clients.ts';

const TONE = { urgent: 'font-medium text-destructive', waiting: 'font-medium text-link', plain: 'text-muted-foreground' } as const;
// Each figure is its own link on its own line: a 24px line box, the least target size (WCAG 2.5.8).
const LINK = 'inline-block min-h-6 leading-6 hover:underline focus-visible:underline';

function FigureLink({ slug, figure, className, children }: { slug: string; figure: SocialFigure; className: string; children: string }) {
  if (figure.link.to === 'channels') {
    return (
      <Link to="/o/$slug/social/channels" params={{ slug }} className={cn(LINK, className)}>
        {children}
      </Link>
    );
  }
  return (
    <Link to="/o/$slug/social" params={{ slug }} search={figure.link.tab ? { tab: figure.link.tab } : {}} className={cn(LINK, className)}>
      {children}
    </Link>
  );
}

export function ClientSocialFigures({ slug, figures, now }: { slug: string; figures: SocialFigures; now?: Date }) {
  const t = useTranslations('clients.social');
  const days = daysSince(figures.lastPostAt, now);
  return (
    <ul className="min-w-44 space-y-0.5 text-sm">
      {socialFigures(figures).map((f) => (
        <li key={f.key} className={f.key === 'waitingClient' ? 'pl-3 text-xs' : undefined}>
          <FigureLink slug={slug} figure={f} className={f.key === 'upcoming' && f.count === 0 ? 'text-subtle-foreground' : TONE[f.tone]}>
            {t(f.key, { count: f.count })}
          </FigureLink>
        </li>
      ))}
      <li className="text-xs">
        <Link to="/o/$slug/social" params={{ slug }} search={{ tab: 'done' }} className={cn(LINK, 'text-subtle-foreground')}>
          {days === null ? t('neverPosted') : t('lastPost', { days })}
        </Link>
      </li>
    </ul>
  );
}
