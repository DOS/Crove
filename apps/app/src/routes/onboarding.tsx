import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { ErrorText, Logo } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { signOut } from '../lib/session-actions.ts';

export function OnboardingPage() {
  const navigate = useNavigate();
  const t = useTranslations('onboarding');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const create = useMutation(
    orpc.org.create.mutationOptions({
      onSuccess: async (org) => {
        await queryClient.invalidateQueries();
        await navigate({ to: '/o/$slug/inbox', params: { slug: org.slug } });
      },
    }),
  );

  // One idempotency key per name: a retried submit returns the org the first one created instead of a second.
  const attempt = useRef<{ name: string; key: string } | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    // The server trims the name, so the key follows the trimmed name.
    const trimmed = name.trim();
    if (attempt.current?.name !== trimmed) attempt.current = { name: trimmed, key: crypto.randomUUID() };
    create.mutate({ name: trimmed, idempotencyKey: attempt.current.key });
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4 py-16">
      <Card className="block w-full max-w-md p-6">
        <Logo />
        <h1 className="mt-6 text-lg font-semibold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        <form className="mt-6 space-y-3" onSubmit={submit}>
          <Label className="flex-col items-stretch gap-1 font-normal">
            <span className="text-muted-foreground">{t('nameLabel')}</span>
            <Input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          </Label>
          {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
          <Button type="submit" size="lg" className="w-full" disabled={create.isPending}>
            {create.isPending ? t('creating') : t('create')}
          </Button>
        </form>
        <button className="mt-4 text-sm text-subtle-foreground hover:text-muted-foreground" onClick={() => void signOut()}>
          {tc('signOut')}
        </button>
      </Card>
    </main>
  );
}
