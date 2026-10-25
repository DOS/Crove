// The legal entities of an org (issue #1278, plan §4.6): the companies, branches and household businesses it keeps
// books for (crove_kernel.legal_entity). Every org has one default entity, created with the org by
// crove_kernel.create_or_replay_org and backfilled for older orgs from the tenant row. Owners and admins list them, add
// one and change one; the runtime audits every change, and the detail keeps the old and the new values (a legal
// entity's name and tax code are public business data). Entities are never deleted: the books will reference them
// (ADR-0021).
//
// The org's tax code lives on the tenant row too, where Finance reads it (a sale or a purchase, #313) and locks the row
// while it posts, and only kernel.org.set_tax_code changes it (tenant_tax_code_guard, #430). The default entity's tax
// code is the org's: the database writes it with every change of the tenant's code (tenant_default_entity_tax_code,
// #1316, so a staff fix on the tenant row moves it too), kernel.legal_entity.update refuses to change it, and the
// database refuses a default entity whose code is not the tenant's (legal_entity_default_tax_code).
import { z } from 'zod';
import { LEGAL_ENTITY_NAME_MAX, normalizeTaxCode, zLegalEntityInput, type LegalEntity, type LegalEntityKind } from '@crove/kernel-contract';
import type { LegalEntityKind as StoredKind, MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

// The contract's kinds and the database's are one list (a compile error if they drift).
const sameKinds: [LegalEntityKind, StoredKind] extends [StoredKind, LegalEntityKind] ? true : never = true;
void sameKinds;

export const KIND_LABELS: Record<LegalEntityKind, string> = {
  company: 'doanh nghiệp, tổ chức',
  branch: 'chi nhánh, đơn vị phụ thuộc',
  household: 'hộ, cá nhân kinh doanh',
};

const INVALID_TAX_CODE = 'Mã số thuế không hợp lệ: 10 chữ số, 10 chữ số kèm 3 chữ số đơn vị phụ thuộc, hoặc 12 chữ số';

// The stored form of a name: one line, runs of whitespace as one space, trimmed; undefined when it cannot be stored.
export function normalizeEntityName(raw: string): string | undefined {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine === '' || oneLine.length > LEGAL_ENTITY_NAME_MAX || /\p{Cc}/u.test(oneLine)) return undefined;
  return oneLine;
}

const COLUMNS = ['id', 'name', 'kind', 'tax_code', 'parent_id', 'is_default', 'created_at', 'updated_at'] as const;
interface Row {
  id: string;
  name: string;
  kind: LegalEntityKind;
  tax_code: string | null;
  parent_id: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}
const view = (r: Row): LegalEntity => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  taxCode: r.tax_code,
  parentId: r.parent_id,
  isDefault: r.is_default,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

type Trx = Pick<CommandContext, 'trx' | 'orgId'>;

// The tax code the input names, normalized, or null; a value that is not a tax code is refused.
function taxCodeOf(raw: string | null): string | null {
  const trimmed = raw?.trim() || null;
  if (!trimmed) return null;
  const taxCode = normalizeTaxCode(trimmed);
  if (!taxCode) throw new DomainError('INVALID_TAX_CODE', 422, INVALID_TAX_CODE);
  return taxCode;
}

function nameOf(raw: string): string {
  const name = normalizeEntityName(raw);
  if (name === undefined) throw new DomainError('INVALID_LEGAL_ENTITY_NAME', 422, `Tên pháp nhân không hợp lệ: một dòng, 1 đến ${LEGAL_ENTITY_NAME_MAX} ký tự`);
  return name;
}

const taxCodeTaken = (taxCode: string) => new DomainError('LEGAL_ENTITY_TAX_CODE_TAKEN', 409, `Mã số thuế ${taxCode} đã thuộc một pháp nhân khác của tổ chức`);

// Refuses a tax code another entity of the org already holds (the unique index decides in the end; see onWrite).
async function assertTaxCodeFree(ctx: Trx, taxCode: string | null, self: string | null): Promise<void> {
  if (!taxCode) return;
  let q = ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('tax_code', '=', taxCode);
  if (self) q = q.where('id', '<>', self);
  if (await q.executeTakeFirst()) throw taxCodeTaken(taxCode);
}

async function assertParent(ctx: Trx, parentId: string | null): Promise<void> {
  if (!parentId) return;
  const parent = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('id', '=', parentId).executeTakeFirst();
  if (!parent) throw new DomainError('LEGAL_ENTITY_PARENT_NOT_FOUND', 422, 'Không tìm thấy pháp nhân cấp trên');
}

// Maps the database's refusals of a write: another entity took the tax code after the check (the unique index), or
// the new parent is below the entity (crove_kernel.legal_entity_no_cycle).
export function onWrite(taxCode: string | null) {
  return (error: unknown): never => {
    const pg = error as { code?: string; message?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === 'legal_entity_tax_code_uq' && taxCode) throw taxCodeTaken(taxCode);
    if (pg.code === '23514' && pg.message === 'LEGAL_ENTITY_CYCLE') {
      throw new DomainError('LEGAL_ENTITY_CYCLE', 422, 'Pháp nhân cấp trên không được là chính nó hay một đơn vị trực thuộc nó');
    }
    throw error;
  };
}

/**
 * Refuses, before kernel.org.set_tax_code writes the tenant row, a code an entity of the org other than the default
 * holds: the database writes the tenant's new code to the default entity (tenant_default_entity_tax_code), where the
 * unique index would refuse it.
 */
export async function assertOrgTaxCodeFree(ctx: Trx, taxCode: string | null): Promise<void> {
  if (!taxCode) return;
  const holder = await ctx.trx
    .selectFrom('crove_kernel.legal_entity')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('tax_code', '=', taxCode)
    .where('is_default', '=', false)
    .executeTakeFirst();
  if (holder) throw taxCodeTaken(taxCode);
}

/**
 * Sets the default entity's tax code to the org's, inside kernel.org.set_tax_code after it wrote the tenant row. The
 * database already did when the tenant's code changed; this repairs a default entity left on an old code before
 * #1316. Refuses a code another entity of the org holds.
 */
export async function setDefaultEntityTaxCode(ctx: Pick<CommandContext, 'trx' | 'orgId' | 'now'> & { userId: string | null }, taxCode: string | null): Promise<void> {
  const entity = await ctx.trx
    .selectFrom('crove_kernel.legal_entity')
    .select(['id', 'tax_code'])
    .where('org_id', '=', ctx.orgId)
    .where('is_default', '=', true)
    .forUpdate()
    .executeTakeFirst();
  // Every org has one (created with it, or backfilled); an org without one is left as it is.
  if (!entity || entity.tax_code === taxCode) return;
  await assertTaxCodeFree(ctx, taxCode, entity.id);
  await ctx.trx
    .updateTable('crove_kernel.legal_entity')
    .set({ tax_code: taxCode, updated_by: ctx.userId, updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', entity.id)
    .execute()
    .catch(onWrite(taxCode));
}

export const legalEntityList = defineQuery({
  name: 'kernel.legal_entity.list',
  input: z.strictObject({}),
  access: ADMINS,
  handler: async (ctx: QueryContext): Promise<LegalEntity[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.legal_entity')
      .select(COLUMNS)
      .where('org_id', '=', ctx.orgId)
      .orderBy('is_default', 'desc')
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(view);
  },
});

export const legalEntityCreate = defineCommand({
  name: 'kernel.legal_entity.create',
  input: zLegalEntityInput,
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input): Promise<LegalEntity> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const name = nameOf(input.name);
    const taxCode = taxCodeOf(input.taxCode);
    await assertParent(ctx, input.parentId);
    await assertTaxCodeFree(ctx, taxCode, null);
    const row = await ctx.trx
      .insertInto('crove_kernel.legal_entity')
      .values({ org_id: ctx.orgId, name, kind: input.kind, tax_code: taxCode, parent_id: input.parentId, created_by: ctx.actor.userId, created_at: ctx.now, updated_at: ctx.now })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow()
      .catch(onWrite(taxCode));
    ctx.audit({ legalEntityId: row.id, entity: { name, kind: input.kind, taxCode, parentId: input.parentId } });
    await ctx.activity('kernel.legal_entity', row.id, 'legal_entity.created', `Thêm pháp nhân ${name} (${KIND_LABELS[input.kind]})`);
    return view(row);
  },
});

export const legalEntityUpdate = defineCommand({
  name: 'kernel.legal_entity.update',
  input: zLegalEntityInput.extend({ legalEntityId: z.uuid() }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input): Promise<LegalEntity> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const name = nameOf(input.name);
    const taxCode = taxCodeOf(input.taxCode);
    const before = await ctx.trx
      .selectFrom('crove_kernel.legal_entity')
      .select(COLUMNS)
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.legalEntityId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('LEGAL_ENTITY_NOT_FOUND', 404, 'Không tìm thấy pháp nhân');

    const next = { name, kind: input.kind, tax_code: taxCode, parent_id: input.parentId };
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((key) => before[key] !== next[key]);
    if (changed.length === 0) {
      ctx.audit({ legalEntityId: before.id, changed: [] });
      return view(before);
    }
    if (changed.includes('tax_code') && before.is_default) {
      throw new DomainError('LEGAL_ENTITY_DEFAULT_TAX_CODE', 422, 'Mã số thuế của pháp nhân mặc định là mã số thuế của tổ chức; hãy đổi ở mục Mã số thuế');
    }
    if (changed.includes('parent_id')) await assertParent(ctx, input.parentId);
    if (changed.includes('tax_code')) await assertTaxCodeFree(ctx, taxCode, before.id);

    const row = await ctx.trx
      .updateTable('crove_kernel.legal_entity')
      .set({ ...next, updated_by: ctx.actor.userId, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', before.id)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow()
      .catch(onWrite(taxCode));

    const field = { name: 'name', kind: 'kind', tax_code: 'taxCode', parent_id: 'parentId' } as const;
    const previous: Record<string, string | null> = {};
    const values: Record<string, string | null> = {};
    for (const key of changed) {
      previous[field[key]] = before[key];
      values[field[key]] = next[key];
    }
    ctx.audit({ legalEntityId: before.id, isDefault: before.is_default, changed: changed.map((k) => field[k]), previous, values });
    await ctx.activity('kernel.legal_entity', before.id, 'legal_entity.updated', `Sửa pháp nhân ${name}`);
    return view(row);
  },
});

export const legalEntityCommands = [legalEntityCreate, legalEntityUpdate];
export const legalEntityQueries = [legalEntityList];
