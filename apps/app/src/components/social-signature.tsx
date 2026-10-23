// A channel's signature (#1190) in the app: its editor on the Channels page (owners and admins), and the composer's
// "Bỏ chữ ký" toggle per channel, which leaves it off one post or puts it back.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { SIGNATURE_MAX, signatureOf, signatureText } from '@crove/mod-social/contract';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText, Spinner } from './ui.tsx';

// A variant's settings with its signature left off (false), or put back: the channel's as it is now, or none.
export function signatureSettings(settings: Record<string, unknown>, off: boolean, channelSignature: string | null | undefined): Record<string, unknown> {
  const { signature: _old, ...rest } = settings;
  if (off) return { ...rest, signature: false };
  return channelSignature ? { ...rest, signature: channelSignature } : rest;
}

// The toggle under a channel in the composer, shown when the channel adds a signature or this post left it off.
// settings: the variant's settings as it goes out (a channel being added holds its channel's signature already).
export function SignatureToggle({ settings, disabled, onChange }: { settings: Record<string, unknown>; disabled: boolean; onChange: (off: boolean) => void }) {
  const t = useTranslations('social');
  const text = signatureText(settings);
  const off = signatureOf(settings) === 'off';
  if (text === null && !off) return null;
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={off} disabled={disabled} onCheckedChange={(checked) => onChange(checked === true)} />
        {t('signatureOff')}
      </label>
      {off ? (
        <p className="text-xs text-subtle-foreground">{t('signatureOffHint')}</p>
      ) : (
        <p className="text-xs whitespace-pre-line text-subtle-foreground">
          {t('signatureAdded')} {text}
        </p>
      )}
    </div>
  );
}

// The channel's signature on the Channels page: the block its new posts end with. Owners and admins set it; a post
// copies it when the channel is added, so the posts already written keep theirs.
export function SignatureEditor({ connectionId, revoked, signature, canEdit }: { connectionId: string; revoked: boolean; signature: string | null; canEdit: boolean }) {
  const t = useTranslations('social');
  const [text, setText] = useState(signature ?? '');
  const save = useMutation({
    mutationFn: (next: string) => client.social.policies.setSignature({ connectionId, signature: next.trim() ? next : null }),
    onSuccess: (r) => setText(r.signature ?? ''),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.social.policies.list.key() }),
  });
  const count = [...text.trim()].length;
  const changed = text.trim() !== (signature ?? '');
  const id = `signature-${connectionId}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium text-muted-foreground">
        {t('signatureTitle')}
      </Label>
      <Textarea id={id} rows={3} value={text} disabled={!canEdit || save.isPending || revoked} placeholder={t('signaturePlaceholder')} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-subtle-foreground">{t(canEdit ? 'signatureHint' : 'signatureAdmins')}</p>
        <span className={count > SIGNATURE_MAX ? 'font-mono text-xs text-destructive' : 'font-mono text-xs text-subtle-foreground'}>
          {count}/{SIGNATURE_MAX}
        </span>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Button size="sm" disabled={!changed || count > SIGNATURE_MAX || save.isPending || revoked} onClick={() => save.mutate(text)}>
            {save.isPending ? <Spinner className="text-current" /> : null}
            {t('signatureSave')}
          </Button>
          {signature && (
            <Button variant="ghost" size="sm" disabled={save.isPending || revoked} onClick={() => save.mutate('')}>
              {t('signatureClear')}
            </Button>
          )}
        </div>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}
