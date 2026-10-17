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
    <a href={link.href} className={cn('hover:text-muted-foreground', className)} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {t('support')}
    </a>
  );
}
