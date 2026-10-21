// The org's team chat for Social alerts (#863), on the Channels page: a Telegram chat (a bot and the chat it was added
// to) or a Discord webhook, and the kinds of alert it gets. Owners and admins save, test and remove it; everyone else
// sees whether it is on. The bot token and the webhook URL are sent once to be checked and sealed, and never come back.
// A test line is sent by the worker: the card asks for it, then reads the alert again until its outcome shows.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { SOCIAL_CHAT_ALERT_KINDS, SOCIAL_CHAT_ALERT_TARGETS } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, Spinner } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

type Target = (typeof SOCIAL_CHAT_ALERT_TARGETS)[number];
type Kind = (typeof SOCIAL_CHAT_ALERT_KINDS)[number];
// The outcomes the worker records for a test line, worded by the card.
const TEST_CODES = ['CHAT_ALERT_REFUSED', 'CHAT_ALERT_RATE_LIMITED', 'CHAT_ALERT_UNREACHABLE', 'CHAT_ALERT_UNREADABLE', 'CHAT_ALERT_OWNER_LEFT'] as const;
const TEST_POLL_MS = 2_000;
const TEST_WAIT_MS = 20_000;

export function ChatAlertCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('social.chatAlert');
  // While a test line is on its way: the last outcome seen before it was asked for, and since when it is awaited.
  const [testing, setTesting] = useState<{ before: string | null; at: number } | null>(null);
  const [testResult, setTestResult] = useState<'done' | 'late' | null>(null);
  const current = useQuery({ ...orpc.social.chatAlert.get.queryOptions({ input: {} }), refetchInterval: testing ? TEST_POLL_MS : false });
  const saved = current.data ?? null;
  const outcome = saved?.lastTestAt ?? null;
  useEffect(() => {
    if (!testing) return;
    if (outcome !== testing.before) {
      setTesting(null);
      setTestResult('done');
      return;
    }
    const left = TEST_WAIT_MS - (Date.now() - testing.at);
    const timer = setTimeout(
      () => {
        setTesting(null);
        setTestResult('late');
      },
      Math.max(0, left),
    );
    return () => clearTimeout(timer);
  }, [testing, outcome]);
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [kinds, setKinds] = useState<Kind[] | null>(null);
  const shown = { target: target ?? saved?.kind ?? 'telegram', kinds: kinds ?? saved?.events ?? [...SOCIAL_CHAT_ALERT_KINDS] };
  const reset = () => {
    setEditing(false);
    setTarget(null);
    setBotToken('');
    setChatId('');
    setWebhookUrl('');
    setKinds(null);
  };
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.chatAlert.get.key() });
  const save = useMutation({
    mutationFn: () => {
      const events = SOCIAL_CHAT_ALERT_KINDS.filter((k) => shown.kinds.includes(k));
      return shown.target === 'telegram' ? client.social.chatAlert.save({ kind: 'telegram', botToken, chatId, events }) : client.social.chatAlert.save({ kind: 'discord', webhookUrl, events });
    },
    onSuccess: () => {
      reset();
      setTestResult(null);
      refresh();
    },
  });
  const test = useMutation({
    mutationFn: () => client.social.chatAlert.test({}),
    onMutate: () => setTestResult(null),
    onSuccess: () => setTesting({ before: outcome, at: Date.now() }),
  });
  const remove = useMutation({
    mutationFn: () => client.social.chatAlert.remove({}),
    onSuccess: () => {
      reset();
      setTestResult(null);
      refresh();
    },
  });
  // Only the error of what the person did last is shown: editing a field or starting another action clears the others.
  const clearErrors = () => {
    save.reset();
    test.reset();
    remove.reset();
  };
  const edit = (set: (value: string) => void) => (e: { target: { value: string } }) => {
    clearErrors();
    set(e.target.value);
  };
  const run = (action: { mutate: () => void }) => () => {
    clearErrors();
    action.mutate();
  };
  const code = saved?.lastTestCode ?? null;
  const testLine =
    testing || test.isPending
      ? t('testing')
      : testResult === 'late'
        ? t('testLate')
        : testResult === 'done'
          ? code === null
            ? t('testSent')
            : (TEST_CODES as readonly string[]).includes(code)
              ? t(`testCodes.${code as (typeof TEST_CODES)[number]}`)
              : t('testFailed')
          : null;
  if (current.isLoading) return <Spinner />;
  const formOpen = canEdit && (editing || !saved);
  const filled = shown.target === 'telegram' ? botToken.trim() !== '' && chatId.trim() !== '' : webhookUrl.trim() !== '';
  const error = save.error ?? test.error ?? remove.error ?? current.error;
  return (
    <div className="space-y-3">
      <p className="text-sm text-foreground">
        {!saved ? t('off') : saved.label ? t('on', { target: t(`targets.${saved.kind}`), label: saved.label }) : t('onUnnamed', { target: t(`targets.${saved.kind}`) })}
      </p>
      {saved && !formOpen && <p className="text-xs text-subtle-foreground">{t('kindsLine', { kinds: saved.events.map((k) => t(`kinds.${k}`)).join(', ') })}</p>}
      {formOpen && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="chat-alert-target" className="text-xs">
              {t('where')}
            </Label>
            <NativeSelect id="chat-alert-target" size="sm" className="w-full sm:w-64" value={shown.target} onChange={(e) => setTarget(e.target.value as Target)}>
              {SOCIAL_CHAT_ALERT_TARGETS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`targets.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {shown.target === 'telegram' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="chat-alert-token" className="text-xs">
                  {t('botToken')}
                </Label>
                <Input id="chat-alert-token" type="password" autoComplete="off" value={botToken} placeholder="123456789:AA..." onChange={edit(setBotToken)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="chat-alert-chat" className="text-xs">
                  {t('chatId')}
                </Label>
                <Input id="chat-alert-chat" autoComplete="off" value={chatId} placeholder="-4012345678" onChange={edit(setChatId)} />
              </div>
              <p className="text-xs text-subtle-foreground sm:col-span-2">{t('telegramHint')}</p>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="chat-alert-webhook" className="text-xs">
                {t('webhookUrl')}
              </Label>
              <Input id="chat-alert-webhook" type="password" autoComplete="off" value={webhookUrl} placeholder="https://discord.com/api/webhooks/..." onChange={edit(setWebhookUrl)} />
              <p className="text-xs text-subtle-foreground">{t('discordHint')}</p>
            </div>
          )}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-foreground">{t('kindsTitle')}</legend>
            {SOCIAL_CHAT_ALERT_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox checked={shown.kinds.includes(k)} onCheckedChange={(checked) => setKinds(checked === true ? [...shown.kinds, k] : shown.kinds.filter((x) => x !== k))} />
                {t(`kinds.${k}`)}
              </label>
            ))}
          </fieldset>
          {saved && <p className="text-xs text-subtle-foreground">{t('reenter')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={save.isPending || !filled || shown.kinds.length === 0} onClick={run(save)}>
              {save.isPending ? <Spinner className="text-current" /> : null}
              {t('save')}
            </Button>
            {saved && (
              <Button size="sm" variant="ghost" onClick={() => {
                  clearErrors();
                  reset();
                }}>
                {t('cancel')}
              </Button>
            )}
          </div>
        </div>
      )}
      {canEdit && saved && !formOpen && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={test.isPending || testing !== null} onClick={run(test)}>
            {test.isPending || testing ? <Spinner className="text-current" /> : null}
            {t('test')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => {
                  clearErrors();
                  setEditing(true);
                }}>
            {t('change')}
          </Button>
          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={run(remove)}>
            {t('remove')}
          </Button>
        </div>
      )}
      {testLine && !test.error && <p className={testResult === 'done' && code !== null ? 'text-xs text-destructive' : 'text-xs text-subtle-foreground'}>{testLine}</p>}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </div>
  );
}
