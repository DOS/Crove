// Org-less identity operations: sign-in bookkeeping, listing orgs, creating an org.
import { sql } from 'kysely';
import type { Db, MemberRole } from '@crove/db';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

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

export async function createOrg(runtime: Runtime, userId: string, name: string): Promise<OrgSummary> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const orgId = await runtime.orgless(async (db) => {
        const { rows } = await sql<{ org_id: string }>`SELECT crove_kernel.create_org(${userId}::uuid, ${slug}, ${name}) AS org_id`.execute(db);
        return rows[0]?.org_id;
      });
      if (!orgId) throw new DomainError('INTERNAL', 500, 'Không tạo được tổ chức');
      return { orgId, slug, name, role: 'owner' };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CONFLICT') continue;
      throw error;
    }
  }
  throw new DomainError('CONFLICT', 409, 'Không tìm được tên rút gọn cho tổ chức');
}
