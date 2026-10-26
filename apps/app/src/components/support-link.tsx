import { useTranslations } from 'use-intl';
import { cn } from '@crove/ui/lib/utils';
import { getConfig } from '../lib/auth.ts';
import { supportLink } from '../lib/support.ts';

// "Góp ý / Hỗ trợ" in the app shell (issue #310); nothing when the deployment sets no SUPPORT_URL.
export function SupportLink({ className }: { className?: string }) {
  const t = useTranslations('nav');
  const link = supportLink(getConfig().supportUrl);
  if (!link) return null;
  return (
    <a
      href={link.href}
      // A visible focus ring wherever the link sits (DESIGN.md §7): the shell's footer and the screens before it (#1516).
      className={cn('rounded-sm hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', className)}
      {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {t('support')}
    </a>
  );
}
