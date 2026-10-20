import { useTranslations } from 'use-intl';
import { cn } from '@crove/ui/lib/utils';
import { getConfig } from '../lib/auth.ts';

// "Trạng thái hệ thống" next to the support link (issue #678): the kernel's /status page, a plain page outside the
// app, so it still loads when parts of the app do not. Nothing when the deployment serves no status page.
export function StatusLink({ className }: { className?: string }) {
  const t = useTranslations('nav');
  if (!getConfig().statusPage) return null;
  return (
    <a href="/status" target="_blank" rel="noopener" className={cn('hover:text-muted-foreground', className)}>
      {t('status')}
    </a>
  );
}
