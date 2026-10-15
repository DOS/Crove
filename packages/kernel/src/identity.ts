// Org-less identity operations: sign-in bookkeeping, listing orgs, creating an org.
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db, MemberRole } from '@crove/db';
import { DomainError, defineCommand, type Runtime, type UserActor } from '@crove/kernel-runtime';

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string;
  name: string | null;
}

export async function upsertIdentity(db: Db, identity: VerifiedIdentity): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT crove_kernel.identity_upsert(${identity.issuer}, ${identity.subject}, ${identity.email}, ${identity.name}) AS id`.execute(db);
  const id = rows[0]?.id;
  if (!id) throw new DomainError('INTERNAL', 500, 'Không tạo được tài khoản');
  return id;
}

// Maps a verified token to its user only after the session checks pass (crove_kernel.identity_resolve), so a
// revoked or disabled session never creates or updates the account. upstream: the self-host db adapter.
export async function resolveIdentity(db: Db, identity: VerifiedIdentity & { sessionId: string; upstream: boolean }): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT crove_kernel.identity_resolve(${identity.issuer}, ${identity.subject}, ${identity.email}, ${identity.name},
      ${identity.sessionId}::uuid, ${identity.upstream}) AS id`.execute(db);
  const id = rows[0]?.id;
  if (!id) throw new DomainError('INTERNAL', 500, 'Không tạo được tài khoản');
  return id;
}

export interface OrgSummary {
  orgId: string;
  slug: string;
  name: string;
  role: MemberRole;
}

export async function myOrgs(db: Db, userId: string): Promise<OrgSummary[]> {
  const { rows } = await sql<{ org_id: string; slug: string; name: string; role: MemberRole }>`
    SELECT org_id, slug, name, role FROM crove_kernel.my_orgs(${userId}::uuid)`.execute(db);
  return rows.map((r) => ({ orgId: r.org_id, slug: r.slug, name: r.name, role: r.role }));
}

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return base.length >= 3 ? base : `org-${Math.random().toString(36).slice(2, 8)}`;
}

// Creates an org with the caller as owner (External-tenant gate T4). The definer creates the tenant and the
// owner membership, or returns the org an earlier request with the same idempotency key created; the runtime
// then enters it as the caller and writes the audit row and the idempotency key in the same transaction.
export const createOrgCommand = defineCommand({
  name: 'kernel.org.create',
  input: z.object({ name: z.string().trim().min(1).max(200) }),
  risk: 'R1',
  access: ['owner'],
  bootstrap: async (trx, actor, input, idempotencyKey) => {
    const { rows } = await sql<{ org_id: string | null }>`
      SELECT crove_kernel.create_or_replay_org(${actor.userId}::uuid, ${slugify(input.name)}, ${input.name}, ${idempotencyKey}) AS org_id`.execute(trx);
    const orgId = rows[0]?.org_id;
    if (!orgId) throw new DomainError('INTERNAL', 500, 'Không tạo được tổ chức');
    return orgId;
  },
  handler: async (ctx): Promise<OrgSummary> => {
    const tenant = await ctx.trx
      .selectFrom('crove_kernel.tenant')
      .select(['org_id', 'slug', 'name'])
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirstOrThrow();
    ctx.audit({ slug: tenant.slug });
    return { orgId: tenant.org_id, slug: tenant.slug, name: tenant.name, role: 'owner' };
  },
});

export function createOrg(runtime: Runtime, actor: UserActor, name: string, idempotencyKey?: string): Promise<OrgSummary> {
  return runtime.executeOrgless<OrgSummary>('kernel.org.create', { name }, { actor, ...(idempotencyKey ? { idempotencyKey } : {}) });
}
