// Who moves a post along and by when (#640), on the post screen. Owners, admins and the post's author change them;
// everyone sees them, and a post past its due date that has not gone out is flagged.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { fromLocalInput, isOverdue, toLocalInput } from '../lib/social-assign.ts';

export function AssignCard({ post, canEdit }: { post: { id: string; assigneeUserId: string | null; dueAt: string | null; status: string }; canEdit: boolean }) {
  const t = useTranslations('social.assign');
  const f = useFormat();
  const org = useQuery(orpc.org.get.queryOptions());
  const members = org.data?.members ?? [];
  const [assignee, setAssignee] = useState(post.assigneeUserId ?? '');
  const [due, setDue] = useState(toLocalInput(post.dueAt));
  useEffect(() => {
    setAssignee(post.assigneeUserId ?? '');
    setDue(toLocalInput(post.dueAt));
  }, [post.assigneeUserId, post.dueAt]);
  const save = useMutation({
    mutationFn: () => client.social.posts.assign({ postId: post.id, assigneeUserId: assignee || null, dueAt: fromLocalInput(due) }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const nameOf = (id: string) => {
    const m = members.find((x) => x.userId === id);
    return m ? (m.displayName ?? m.email) : t('formerMember');
  };
  const changed = assignee !== (post.assigneeUserId ?? '') || due !== toLocalInput(post.dueAt);
  const overdue = isOverdue(post, Date.now());
  return (
    <Card className="block space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        {overdue && <Badge variant="destructive">{t('overdue')}</Badge>}
      </div>
      {canEdit ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="post-assignee">{t('assignee')}</Label>
            <NativeSelect id="post-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <NativeSelectOption value="">{t('nobody')}</NativeSelectOption>
              {members.map((m) => (
                <NativeSelectOption key={m.userId} value={m.userId}>
                  {m.displayName ?? m.email}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="post-due">{t('due')}</Label>
            <Input id="post-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Button size="sm" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
              {t('save')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {post.assigneeUserId ? nameOf(post.assigneeUserId) : t('nobody')}
          {post.dueAt ? ` · ${t('dueOn', { when: f.dateTime(post.dueAt) })}` : ''}
        </p>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </Card>
  );
}
