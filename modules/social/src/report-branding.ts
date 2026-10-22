// White-label client reports (#1053), as Metricool's, Agorapulse's and Sprout's agency plans brand them: an org's report
// branding, a display name, a logo, one accent colour and "hide Crove". The public report and review pages and the plan
// print show it instead of Crove's logo, and the report mail uses the accent and the name. Owners and admins save and
// remove it (social.report_branding.save, social.report_branding.remove, R1, audited without the logo's bytes); every
// member reads it (social.report_branding.get), for the settings and the plan print.
//
// The logo is a small inline data URL the browser makes from an image of the Social library (scaled to at most 256 px
// on its longest side), so the public views' definers return it with the page and no new public route serves a file.
// The command refuses anything but PNG, WebP or JPEG whose magic number matches the declared type, and anything over
// 64 KB; the table's CHECK says the same again. An accent must be #rrggbb with at least 3:1 contrast against the page.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { accentReadable, BRAND_LOGO_MAX_BYTES, BRAND_NAME_MAX, checkLogoDataUrl, logoDataUrlMax, normalizeAccent, type ReportBrand } from './domain/report-branding.ts';
import type { Trx } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// No NUL or other control characters: the name is shown on a public page and in a mail header.
const zName = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\s+/gu, ' ').trim())
  .pipe(z.string().max(BRAND_NAME_MAX))
  .refine((s) => !/\p{Cc}/u.test(s), 'control characters are not allowed');

export const zReportBrandingSave = z.strictObject({
  // Empty or absent: the org's own name.
  name: zName.nullable().optional(),
  // A data URL; checked in the handler, so a wrong type and an oversized logo each get their own refusal.
  logo: z
    .string()
    .max(logoDataUrlMax() + 1024)
    .nullable()
    .optional(),
  accent: z.string().max(16).nullable().optional(),
  hideCrove: z.boolean(),
});

async function lockBranding(ctx: CommandContext) {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.report_branding:${ctx.orgId}`}))`.execute(ctx.trx);
  return ctx.trx.selectFrom('crove_social.report_branding').select('id').where('org_id', '=', ctx.orgId).orderBy('created_at').orderBy('id').execute();
}

export const reportBrandingSave = defineCommand({
  name: 'social.report_branding.save',
  input: zReportBrandingSave,
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const name = input.name ? input.name : null;
    let logo: string | null = null;
    let logoBytes: number | null = null;
    if (input.logo) {
      const checked = checkLogoDataUrl(input.logo);
      if (!checked.ok && checked.reason === 'size') throw new DomainError('BRAND_LOGO_TOO_LARGE', 413, `Logo lớn hơn ${BRAND_LOGO_MAX_BYTES / 1024} KB; hãy chọn ảnh nhỏ hơn`);
      if (!checked.ok) throw new DomainError('BRAND_LOGO_INVALID', 422, 'Logo phải là ảnh PNG, WebP hoặc JPEG');
      logo = input.logo;
      logoBytes = checked.bytes;
    }
    let accent: string | null = null;
    if (input.accent) {
      accent = normalizeAccent(input.accent);
      if (!accent) throw new DomainError('BRAND_ACCENT_INVALID', 422, 'Màu nhấn phải ở dạng #rrggbb');
      if (!accentReadable(accent)) throw new DomainError('BRAND_ACCENT_LOW_CONTRAST', 422, 'Màu nhấn quá nhạt so với nền trang; hãy chọn màu đậm hơn');
    }
    const values = { display_name: name, logo, accent, hide_crove: input.hideCrove, updated_by: userId, updated_at: ctx.now };
    const existing = await lockBranding(ctx);
    const first = existing[0];
    if (first) {
      await ctx.trx.updateTable('crove_social.report_branding').set(values).where('org_id', '=', ctx.orgId).where('id', '=', first.id).execute();
    } else {
      await ctx.trx
        .insertInto('crove_social.report_branding')
        .values({ org_id: ctx.orgId, ...values, created_at: ctx.now })
        .execute();
    }
    // The logo's size, not its bytes: the audit log is no place for an image.
    ctx.audit({ name, accent, hide_crove: input.hideCrove, logo_bytes: logoBytes });
    return { saved: true };
  },
});

export const reportBrandingRemove = defineCommand({
  name: 'social.report_branding.remove',
  input: z.strictObject({}),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx) => {
    requireUser(ctx);
    const rows = await lockBranding(ctx);
    if (rows.length > 0)
      await ctx.trx
        .deleteFrom('crove_social.report_branding')
        .where('org_id', '=', ctx.orgId)
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
    ctx.audit({});
    return { removed: rows.length > 0 };
  },
});

/** The org's report branding, or null when none is saved (the first row, as the commands keep one). */
export async function reportBrandingOf(trx: Trx, orgId: string): Promise<(ReportBrand & { updatedAt: string }) | null> {
  const row = await trx
    .selectFrom('crove_social.report_branding')
    .select(['display_name', 'logo', 'accent', 'hide_crove', 'updated_at'])
    .where('org_id', '=', orgId)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  if (!row) return null;
  return { name: row.display_name, logo: row.logo, accent: row.accent, hideCrove: row.hide_crove, updatedAt: row.updated_at.toISOString() };
}

export const reportBrandingGet = defineQuery({
  name: 'social.report_branding.get',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) => reportBrandingOf(ctx.trx, ctx.orgId),
});

export const reportBrandingCommands = [reportBrandingSave, reportBrandingRemove];
export const reportBrandingQueries = [reportBrandingGet];
