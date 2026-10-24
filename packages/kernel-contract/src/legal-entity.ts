import { z } from 'zod';
import { zId } from './schemas.ts';

// The legal entities of an org (issue #1278, plan §4.6): the companies, branches and household businesses it keeps
// books for. Every org has one default entity, created with the org; its tax code is the org's (kernel.org.set_tax_code).
//   company    an enterprise or other organization (10-digit tax code);
//   branch     a branch or other dependent unit (the company's code with a 3-digit suffix);
//   household  a household or individual business (12-digit code).
// The same list as the database's CHECK constraint (LEGAL_ENTITY_KINDS in @crove/db, which the kernel keeps in step).
export const LEGAL_ENTITY_KINDS = ['company', 'branch', 'household'] as const;
export type LegalEntityKind = (typeof LEGAL_ENTITY_KINDS)[number];
export const zLegalEntityKind = z.enum(LEGAL_ENTITY_KINDS);
export const LEGAL_ENTITY_NAME_MAX = 200;

export const zLegalEntity = z.object({
  id: zId,
  name: z.string(),
  kind: zLegalEntityKind,
  taxCode: z.string().nullable(),
  parentId: zId.nullable(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LegalEntity = z.infer<typeof zLegalEntity>;

// What an owner or admin sets: the whole entity, every time. The tax code is normalized (normalizeTaxCode) and the
// name put on one line by the server; an empty tax code is null.
export const zLegalEntityInput = z.object({
  name: z.string().max(1000),
  kind: zLegalEntityKind,
  taxCode: z.string().trim().max(20).nullable(),
  parentId: zId.nullable(),
});
export type LegalEntityInput = z.infer<typeof zLegalEntityInput>;
