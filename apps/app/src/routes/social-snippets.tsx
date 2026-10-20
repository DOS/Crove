// Saved snippets (#584): the org's hashtags, signatures and post templates. Members add them and change or delete
// their own; owners and admins any. The composer puts one in the text at the cursor.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { PROVIDERS } from '@crove/mod-social/contract';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';

type Snippet = Awaited<ReturnType<typeof client.social.snippets.list>>[number];
type Draft = { name: string; body: string; provider: string; isTemplate: boolean };
const EMPTY: Draft = { name: '', body: '', provider: '', isTemplate: false };

function SnippetForm({ initial, onSave, onCancel, pending, error }: { initial: Draft; onSave: (d: Draft) => void; onCancel?: () => void; pending: boolean; error: unknown }) {
  const t = useTranslations('social.snippets');
  const [d, setD] = useState(initial);
  const valid = d.name.trim() !== '' && d.body.trim() !== '';
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !pending) onSave(d);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
        <div className="space-y-1.5">
          <Label htmlFor="snippet-name">{t('name')}</Label>
          <Input id="snippet-name" value={d.name} maxLength={100} placeholder={t('namePlaceholder')} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="snippet-provider">{t('provider')}</Label>
          <NativeSelect id="snippet-provider" value={d.provider} onChange={(e) => setD({ ...d, provider: e.target.value })}>
            <NativeSelectOption value="">{t('anyProvider')}</NativeSelectOption>
            {PROVIDERS.filter((p) => p !== 'sandbox').map((p) => (
              <NativeSelectOption key={p} value={p}>
                {providerName(p)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="snippet-body">{t('body')}</Label>
        <Textarea id="snippet-body" value={d.body} maxLength={10_000} rows={4} placeholder={t('bodyPlaceholder')} onChange={(e) => setD({ ...d, body: e.target.value })} />
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={d.isTemplate} onCheckedChange={(checked) => setD({ ...d, isTemplate: checked === true })} />
        {t('isTemplate')}
      </label>
      {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || pending}>
          {pending ? <Spinner className="text-current" /> : null}
          {t('save')}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

function Row({ s }: { s: Snippet }) {
  const t = useTranslations('social.snippets');
  const [editing, setEditing] = useState(false);
  const done = () => void queryClient.invalidateQueries({ queryKey: orpc.social.snippets.list.key() });
  const update = useMutation({
    mutationFn: (d: Draft) => client.social.snippets.update({ snippetId: s.id, name: d.name.trim(), body: d.body.trim(), provider: d.provider || null, isTemplate: d.isTemplate }),
    onSuccess: () => {
      setEditing(false);
      done();
    },
  });
  const remove = useMutation({ mutationFn: () => client.social.snippets.remove({ snippetId: s.id }), onSuccess: done });
  if (editing) {
    return (
      <Card className="block p-4">
        <SnippetForm initial={{ name: s.name, body: s.body, provider: s.provider ?? '', isTemplate: s.isTemplate }} onSave={(d) => update.mutate(d)} onCancel={() => setEditing(false)} pending={update.isPending} error={update.error} />
      </Card>
    );
  }
  return (
    <Card className="block space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{s.name}</span>
        {s.isTemplate && <Badge variant="secondary">{t('template')}</Badge>}
        <Badge variant="outline">{s.provider ? providerName(s.provider) : t('anyProvider')}</Badge>
        {s.mine && (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t('confirmDelete', { name: s.name }))) remove.mutate();
              }}
            >
              {t('delete')}
            </Button>
          </div>
        )}
      </div>
      <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-muted-foreground">{s.body}</p>
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </Card>
  );
}

export function SocialSnippetsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social.snippets');
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canWrite = role === 'owner' || role === 'admin' || role === 'member';
  const list = useQuery(orpc.social.snippets.list.queryOptions({ input: {} }));
  const [formKey, setFormKey] = useState(0);
  const create = useMutation({
    mutationFn: (d: Draft) => client.social.snippets.create({ name: d.name.trim(), body: d.body.trim(), provider: d.provider || null, isTemplate: d.isTemplate }),
    onSuccess: () => {
      setFormKey((k) => k + 1);
      void queryClient.invalidateQueries({ queryKey: orpc.social.snippets.list.key() });
    },
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link to="/o/$slug/social" params={{ slug }} className="inline-flex h-9 items-center px-2.5 text-sm text-muted-foreground hover:text-foreground">
            {t('back')}
          </Link>
        }
      />
      {canWrite && (
        <Card className="block p-4">
          <h3 className="mb-3 text-sm font-medium text-foreground">{t('new')}</h3>
          <SnippetForm key={formKey} initial={EMPTY} onSave={(d) => create.mutate(d)} pending={create.isPending} error={create.error} />
        </Card>
      )}
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : (list.data ?? []).length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <div className="space-y-3">
          {(list.data ?? []).map((s) => (
            <Row key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
