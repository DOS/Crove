// The org's approval rule for the ledger's proposals in Settings (issue #1425, the screen for #1402). Every member sees
// which rule is in force; only an owner switches it, R3, so the switch asks for a fresh second factor and then runs
// again. Under `accountant` only the chief accountant approves (P09), so the server refuses the switch while nobody
// holds that role; the refusal points to the member roles on this page. The server enforces every rule.
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { ErrorText, Spinner } from '../components/ui.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

export const APPROVAL_PRESETS = ['founder', 'accountant'] as const;
type Preset = (typeof APPROVAL_PRESETS)[number];
const isPreset = (value: string): value is Preset => (APPROVAL_PRESETS as readonly string[]).includes(value);

// The members card's id, for the refusal's link to the role assignments.
export const MEMBERS_CARD_ID = 'settings-members';

function showMembers() {
  const card = document.getElementById(MEMBERS_CARD_ID);
  card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card?.focus({ preventScroll: true });
}

export function ApprovalPresetCard({ preset, isOwner }: { preset: string; isOwner: boolean }) {
  const t = useTranslations('approvalPreset');
  const id = useId();
  const [chosen, setChosen] = useState(preset);
  const save = useMutation(
    orpc.org.setApprovalPreset.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries({ queryKey: orpc.org.get.key() });
        toast(t('saved', { rule: isPreset(result.preset) ? t(`presets.${result.preset}.title`) : result.preset }));
      },
    }),
  );
  const saveNow = () => save.mutate({ preset: chosen });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    saveNow();
  };
  const code = (save.error as { code?: string } | null)?.code;

  return (
    <Card role="region" className="block p-4" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="text-sm font-medium text-muted-foreground">
        {t('title')}
      </p>
      <p className="mt-1 text-sm text-subtle-foreground">{t('intro')}</p>
      {isOwner ? (
        <form className="mt-3 space-y-3" onSubmit={submit}>
          <fieldset className="space-y-2" disabled={save.isPending}>
            <legend className="sr-only">{t('title')}</legend>
            {APPROVAL_PRESETS.map((key) => (
              <label key={key} className="flex cursor-pointer gap-3 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-primary/5">
                <input
                  type="radio"
                  name={`${id}-preset`}
                  value={key}
                  checked={chosen === key}
                  onChange={() => {
                    save.reset();
                    setChosen(key);
                  }}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span>
                  <span className="block font-medium text-foreground">
                    {t(`presets.${key}.title`)}
                    {preset === key && <span className="ml-2 text-xs font-normal text-subtle-foreground">{t('current')}</span>}
                  </span>
                  <span className="mt-0.5 block text-muted-foreground">{t(`presets.${key}.body`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-subtle-foreground">{t('saveHint')}</p>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={chosen === preset || save.isPending}>
              {t('save')}
            </Button>
            {save.isPending && <Spinner />}
          </div>
        </form>
      ) : (
        <div className="mt-3 rounded-lg border p-3 text-sm">
          <p className="font-medium text-foreground">{isPreset(preset) ? t(`presets.${preset}.title`) : preset}</p>
          {isPreset(preset) && <p className="mt-0.5 text-muted-foreground">{t(`presets.${preset}.body`)}</p>}
          <p className="mt-2 text-xs text-subtle-foreground">{t('ownerOnly')}</p>
        </div>
      )}
      {save.error &&
        (isStepUpRequired(save.error) ? (
          // R3: after a fresh second factor the same switch runs again.
          <div className="mt-3">
            <StepUpPrompt action={t('stepUp', { rule: isPreset(chosen) ? t(`presets.${chosen}.title`) : chosen })} onVerified={saveNow} />
          </div>
        ) : (
          <div className="mt-3 space-y-1">
            <ErrorText>{errorMessage(save.error)}</ErrorText>
            {code === 'NO_CHIEF_ACCOUNTANT' && (
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={showMembers}>
                {t('giveRole')}
              </Button>
            )}
          </div>
        ))}
    </Card>
  );
}
