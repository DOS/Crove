// A member's roles in Settings (issue #1279): owners and admins see which built-in roles each member holds (the chief
// accountant, an outside accountant limited to one legal entity, ...); owners give and take them back. Giving or taking
// a role is R3 like every membership change: without a second factor in the last 5 minutes the server answers
// STEP_UP_REQUIRED and the step-up prompt asks for one, then the same request runs again with its key. The server
// enforces every rule (owners only, an entity for an entity role, no last-entity revoke that would widen what the member
// sees); the screen only offers what can succeed and shows the server's reason otherwise.
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { LegalEntity, MemberRoles, RoleAssignment } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { ErrorText } from '../components/ui.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { assignableRoles, roleNeedsEntity } from '../lib/member-roles.ts';

const refresh = () => queryClient.invalidateQueries();

function AssignedRole({ assignment, entities, canRevoke, name }: { assignment: RoleAssignment; entities: readonly LegalEntity[]; canRevoke: boolean; name: string }) {
  const t = useTranslations('memberRoles');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const revoke = useMutation(
    orpc.org.revokeRole.mutationOptions({
      onSuccess: () => {
        setKey(crypto.randomUUID());
        void refresh();
      },
    }),
  );
  const entity = assignment.legalEntityId ? entities.find((e) => e.id === assignment.legalEntityId)?.name ?? t('unknownEntity') : null;
  const label = entity ? t('withEntity', { role: t(`roles.${assignment.roleKey}`), entity }) : t(`roles.${assignment.roleKey}`);
  return (
    <li className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1">
        <Badge variant="secondary">{label}</Badge>
        {canRevoke && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={revoke.isPending}
            aria-label={t('revokeOf', { role: label, name })}
            onClick={() => revoke.mutate({ assignmentId: assignment.id, idempotencyKey: key })}
          >
            {t('revoke')}
          </Button>
        )}
      </span>
      {revoke.error &&
        (isStepUpRequired(revoke.error) ? (
          <StepUpPrompt
            enroll={false}
            action={t('stepUpRevoke', { role: label, name })}
            onVerified={() => revoke.variables && revoke.mutate(revoke.variables)}
            onCancel={() => revoke.reset()}
          />
        ) : (
          <ErrorText>{errorMessage(revoke.error)}</ErrorText>
        ))}
    </li>
  );
}

function AssignRole({ userId, name, baseRole, catalog, held, entities }: {
  userId: string;
  name: string;
  baseRole: string;
  catalog: MemberRoles['roles'];
  held: readonly RoleAssignment[];
  entities: readonly LegalEntity[];
}) {
  const t = useTranslations('memberRoles');
  const tc = useTranslations('common');
  const choices = assignableRoles(catalog, held, baseRole);
  const [open, setOpen] = useState(false);
  const [roleKey, setRoleKey] = useState('');
  const [entityId, setEntityId] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const assign = useMutation(
    orpc.org.assignRole.mutationOptions({
      onSuccess: () => {
        setKey(crypto.randomUUID());
        setOpen(false);
        setRoleKey('');
        setEntityId('');
        void refresh();
      },
    }),
  );
  if (choices.length === 0) return null;
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={t('assignTo', { name })}>
        {t('assign')}
      </Button>
    );
  }
  const role = choices.find((r) => r.key === roleKey);
  const needsEntity = role ? roleNeedsEntity(role) : false;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!role) return;
    assign.mutate({ userId, roleKey: role.key, legalEntityId: needsEntity ? entityId || null : null, idempotencyKey: key });
  };
  return (
    <form className="w-full max-w-sm space-y-2" onSubmit={submit} aria-label={t('assignTo', { name })}>
      <NativeSelect
        size="sm"
        className="w-full"
        value={roleKey}
        onChange={(e) => {
          setRoleKey(e.target.value);
          setEntityId('');
          assign.reset();
        }}
        aria-label={t('role')}
      >
        <NativeSelectOption value="">{t('pickRole')}</NativeSelectOption>
        {choices.map((r) => (
          <NativeSelectOption key={r.key} value={r.key}>
            {t(`roles.${r.key}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {role && <p className="text-xs text-subtle-foreground">{t(`hints.${role.key}`)}</p>}
      {needsEntity && (
        <NativeSelect size="sm" className="w-full" value={entityId} onChange={(e) => setEntityId(e.target.value)} aria-label={t('entity')}>
          <NativeSelectOption value="">{t('pickEntity')}</NativeSelectOption>
          {entities
            .filter((e) => !held.some((a) => a.roleKey === role?.key && a.legalEntityId === e.id))
            .map((e) => (
            <NativeSelectOption key={e.id} value={e.id}>
              {e.taxCode ? `${e.name} (${e.taxCode})` : e.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={assign.isPending || !role || (needsEntity && !entityId)}>
          {t('confirmAssign')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            assign.reset();
          }}
        >
          {tc('cancel')}
        </Button>
      </div>
      {assign.error &&
        (isStepUpRequired(assign.error) ? (
          <StepUpPrompt
            enroll={false}
            action={t('stepUpAssign', { role: role ? t(`roles.${role.key}`) : '', name })}
            onVerified={() => assign.variables && assign.mutate(assign.variables)}
            onCancel={() => assign.reset()}
          />
        ) : (
          <ErrorText>{errorMessage(assign.error)}</ErrorText>
        ))}
    </form>
  );
}

// The roles of one member, for owners and admins; isOwner adds the controls to give and take them back.
export function MemberRolesRow({
  userId,
  name,
  baseRole,
  data,
  entities,
  isOwner,
}: {
  userId: string;
  name: string;
  baseRole: string;
  data: MemberRoles;
  entities: readonly LegalEntity[];
  isOwner: boolean;
}) {
  const t = useTranslations('memberRoles');
  const held = data.assignments.filter((a) => a.userId === userId);
  if (held.length === 0 && !isOwner) return null;
  return (
    <div className="mt-2 flex flex-col items-end gap-2" aria-label={t('rolesOf', { name })}>
      {held.length > 0 && (
        <ul className="flex flex-col items-end gap-1">
          {held.map((a) => (
            <AssignedRole key={a.id} assignment={a} entities={entities} canRevoke={isOwner} name={name} />
          ))}
        </ul>
      )}
      {isOwner && <AssignRole userId={userId} name={name} baseRole={baseRole} catalog={data.roles} held={held} entities={entities} />}
    </div>
  );
}
