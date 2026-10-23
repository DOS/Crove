// Sharing a page into a new draft (#1235), on the Channels page with the other Social settings: the bookmarklet of
// this org, to copy into a bookmark, and how the installed app shows in a phone's share menu. The bookmarklet holds
// the org's address only, no token: anyone may copy it, and it opens the composer only for a member who signs in.
import { useParams } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { bookmarklet } from '../lib/social-share.ts';

export function ShareCard() {
  const t = useTranslations('social.share');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const code = bookmarklet(window.location.origin, slug);
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Without the clipboard API (a page not served over https or localhost), or when it refuses, the code is selected
  // for the person to copy.
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
      field.current?.focus();
      field.current?.select();
    }
  };
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{t('cardTitle')}</p>
        <p className="text-xs text-subtle-foreground">{t('cardHint')}</p>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">{t('bookmarkletTitle')}</p>
        <div className="flex gap-2">
          <Input ref={field} readOnly value={code} aria-label={t('bookmarkletLabel')} className="min-w-0 font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? t('copied') : t('copy')}
          </Button>
        </div>
        <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
          <li>{t('step1')}</li>
          <li>{t('step2')}</li>
          <li>{t('step3')}</li>
        </ol>
      </div>
      <div className="space-y-0.5 text-xs text-subtle-foreground">
        <p>{t('android')}</p>
        <p>{t('ios')}</p>
      </div>
    </Card>
  );
}
