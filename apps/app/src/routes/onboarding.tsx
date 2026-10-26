import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { normalizeTaxCode } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { ErrorText, Field, FieldError, fieldControl, focusFirstInvalid, isEmailAddress, Logo, OrgLeftNotice, useFieldErrors } from '../components/ui.tsx';
import { SupportLink } from '../components/support-link.tsx';
import { client, clientForOrg, errorMessage, orglessClient, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { signOut } from '../lib/session-actions.ts';

// A new org (issue #324): a firm adding a client types the client's tax code, the public registry fills in the name and
// address where the server has a lookup, and the contact person's email opens the new org's invite form. The org is
// created first; its tax code and address are set right after, in the new org.
export function OnboardingPage() {
  const navigate = useNavigate();
  const t = useTranslations('onboarding');
  const tc = useTranslations('common');
  const me = useQuery(orpc.me.get.queryOptions());
  const hasOrgs = (me.data?.orgs.length ?? 0) > 0;
  const finance = getConfig().modules.includes('finance');
  const [taxCode, setTaxCode] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [contact, setContact] = useState('');
  // Each field's problem sits under it (#1515): checked on leaving the field and on submit.
  const fields = useFieldErrors<'taxCode' | 'name' | 'contact'>((field) => {
    if (field === 'taxCode') return taxCode.trim() && !normalizeTaxCode(taxCode) ? t('taxCodeInvalid') : null;
    if (field === 'name') return name.trim() ? null : t('nameRequired');
    return contact.trim() && !isEmailAddress(contact) ? t('contactInvalid') : null;
  });
  // Why the tax code matters stays behind the info button, so the form is labels and fields only.
  const [aboutTaxCode, setAboutTaxCode] = useState(false);

  const lookup = useMutation({
    mutationFn: (code: string) => orglessClient.taxRegistry.lookup({ taxCode: code }),
    onSuccess: (entry) => {
      setTaxCode(entry.taxCode);
      setName(entry.name);
      setAddress(entry.address ?? '');
    },
  });

  // One idempotency key per name: a retried submit returns the org the first one created instead of a second.
  const attempt = useRef<{ name: string; key: string } | null>(null);
  const create = useMutation({
    mutationFn: async (input: { name: string; taxCode: string | null; address: string | null; contact: string | null }) => {
      if (attempt.current?.name !== input.name) attempt.current = { name: input.name, key: crypto.randomUUID() };
      const org = await client.org.create({ name: input.name, idempotencyKey: attempt.current.key });
      const inOrg = clientForOrg(org.slug);
      if (input.taxCode) await inOrg.org.setTaxCode({ taxCode: input.taxCode });
      if (input.address) await inOrg.org.setAddress({ address: input.address });
      return org;
    },
    onSuccess: async (org, input) => {
      await queryClient.invalidateQueries();
      // Inviting is R3 (a fresh second factor): the org's own invite form asks for it and shows the link.
      if (input.contact) await navigate({ to: '/o/$slug/settings', params: { slug: org.slug }, search: { invite: input.contact } });
      else await navigate({ to: '/o/$slug/inbox', params: { slug: org.slug } });
    },
  });

  function lookUp() {
    const code = normalizeTaxCode(taxCode);
    if (fields.check('taxCode') && code) lookup.mutate(code);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fields.checkAll(['taxCode', 'name', 'contact'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    const code = taxCode.trim() ? normalizeTaxCode(taxCode) : null;
    // The server trims the name, so the key follows the trimmed name.
    create.mutate({ name: name.trim(), taxCode: code, address: address.trim() || null, contact: contact.trim() || null });
  }

  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-background px-4 py-16">
      <Card className="block w-full max-w-md p-6">
        <OrgLeftNotice />
        <Logo />
        <h1 className="mt-6 text-lg font-semibold text-foreground">{hasOrgs ? t('titleAnother') : t('title')}</h1>
        <form className="mt-6 space-y-3" noValidate onSubmit={submit}>
          {finance && (
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <Label htmlFor="onboarding-tax-code" className="font-normal text-muted-foreground">
                  {t('taxCodeLabel')}
                </Label>
                <button
                  type="button"
                  className="rounded-sm p-0.5 text-subtle-foreground outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t('taxCodeAbout')}
                  aria-expanded={aboutTaxCode}
                  aria-controls="onboarding-tax-code-about"
                  onClick={() => setAboutTaxCode(!aboutTaxCode)}>
                  <NavIcon name="info" />
                </button>
              </div>
              <div className="flex gap-2">
                <Input
                  {...fieldControl('onboarding-tax-code', { error: Boolean(fields.of('taxCode')) })}
                  className="font-mono"
                  maxLength={20}
                  inputMode="numeric"
                  value={taxCode}
                  onChange={(e) => {
                    setTaxCode(e.target.value);
                    fields.edit('taxCode');
                    lookup.reset();
                  }}
                  onBlur={(e) => fields.blur('taxCode', e.target.value)}
                  placeholder="0101234567"
                />
                {getConfig().taxCodeLookup && (
                  <Button type="button" variant="outline" className="shrink-0" disabled={lookup.isPending || !taxCode.trim()} onClick={lookUp}>
                    {lookup.isPending ? t('lookingUp') : t('lookUp')}
                  </Button>
                )}
              </div>
              {/* Always in the page, so the button's aria-controls names an element; hidden until the button opens it. */}
              <p id="onboarding-tax-code-about" hidden={!aboutTaxCode} className="text-xs text-muted-foreground">
                {getConfig().taxCodeLookup ? `${t('taxCodeHint')} ${t('taxCodeHintLookup')}` : t('taxCodeHint')}
              </p>
              <FieldError id="onboarding-tax-code">{fields.of('taxCode')}</FieldError>
              {lookup.error && <ErrorText>{errorMessage(lookup.error)}</ErrorText>}
            </div>
          )}
          <Field label={t('nameLabel')} error={fields.of('name')}>
            {(control) => (
              <Input
                {...control}
                required
                maxLength={200}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  fields.edit('name');
                }}
                placeholder={t('namePlaceholder')}
              />
            )}
          </Field>
          <Field label={t('addressLabel')}>
            {(control) => <Input {...control} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t('addressPlaceholder')} />}
          </Field>
          <Field label={t('contactLabel')} error={fields.of('contact')}>
            {(control) => (
              <Input
                {...control}
                type="email"
                maxLength={320}
                value={contact}
                onChange={(e) => {
                  setContact(e.target.value);
                  fields.edit('contact');
                }}
                onBlur={(e) => fields.blur('contact', e.target.value)}
                placeholder={t('contactPlaceholder')}
              />
            )}
          </Field>
          {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
          <Button type="submit" size="lg" className="w-full" disabled={create.isPending}>
            {create.isPending ? t('creating') : t('create')}
          </Button>
        </form>
        <div className="mt-4 flex items-center justify-between text-sm">
          {hasOrgs ? (
            <Link to="/" className="text-subtle-foreground hover:text-muted-foreground">
              {t('back')}
            </Link>
          ) : (
            <span />
          )}
          <button className="text-subtle-foreground hover:text-muted-foreground" onClick={() => void signOut()}>
            {tc('signOut')}
          </button>
        </div>
      </Card>
      {/* Help in the same place as on every screen of the app (DESIGN.md §7, 3.2.6; #1516). */}
      <SupportLink className="mt-4 text-sm text-link" />
    </main>
  );
}
