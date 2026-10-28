// The records a note is linked to (issue #1672, notes plan §3.4), as the reader may open them now: the server checks
// each through its module in the reader's context, so a record of another legal entity, one the reader's role may
// not see, or one whose module is off shows as "Bản ghi không mở được", by its kind only. Each record the reader can
// open links to its page.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { NoteLink } from '@crove/kernel-contract';

const KIND = {
  'kernel.party': 'party',
  'kernel.file': 'file',
  'finance.purchase_document': 'purchase_document',
  'finance.journal_entry': 'journal_entry',
  'crm.booking': 'booking',
} as const satisfies Record<NoteLink['targetType'], string>;

function Open({ link, slug, children }: { link: NoteLink; slug: string; children: string }) {
  const className = 'text-link hover:underline';
  if (link.targetType === 'finance.purchase_document') {
    return (
      <Link to="/o/$slug/documents" params={{ slug }} className={className}>
        {children}
      </Link>
    );
  }
  if (link.targetType === 'finance.journal_entry') {
    return (
      <Link to="/o/$slug/journal" params={{ slug }} hash={`entry-${link.targetId}`} className={className}>
        {children}
      </Link>
    );
  }
  if (link.targetType === 'crm.booking') {
    return (
      <Link to="/o/$slug/bookings" params={{ slug }} className={className}>
        {children}
      </Link>
    );
  }
  return <span className="text-foreground">{children}</span>;
}

export function NoteLinks({ links, slug }: { links: NoteLink[]; slug: string }) {
  const t = useTranslations('notes.links');
  if (links.length === 0) return null;
  return (
    <section aria-labelledby="note-links" className="space-y-1">
      <h3 id="note-links" className="text-xs font-medium text-muted-foreground">
        {t('title')}
      </h3>
      <ul className="space-y-1 text-sm">
        {links.map((link) => (
          <li key={link.id} data-testid="note-link" className="flex flex-wrap items-baseline gap-2">
            {link.available ? (
              <Open link={link} slug={slug}>
                {t(`types.${KIND[link.targetType]}`)}
              </Open>
            ) : (
              <>
                <span className="text-muted-foreground">{t(`types.${KIND[link.targetType]}`)}</span>
                <span className="text-xs text-subtle-foreground">{t('unavailable')}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
