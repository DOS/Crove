// Activity summaries keep no classified value (#1634, after #1626): crove_kernel.activity.summary is text a member reads
// in a record's timeline, kept with the record and out of reach of the PDPL erasure (#923), so it names what happened,
// never a person's or an org's name, tax code, address, email or other classified value. The record's page shows its
// current values beside the timeline.
// A source scan of the summary (the fourth argument) of every ctx.activity(...) call. It fails when the summary reads a
// column some manifest classifies (anything but internal), in snake_case or camelCase: inside a template's ${...}
// (`${party.name}`, `${taxCode}`), or as the whole summary (`input.name`). The scan reads only the call's text: a summary
// built elsewhere and passed in by name (`summary`, `label`) is not checked here, so build it from internal values only.
// Column names that are also ordinary words of internal data (an account's name, an asset's name) are listed below with
// their reason, per file; adding one says that value is not a person's or an org's.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, SCANNED, balanced, blank, classifiedColumns, snake, sources } from './source-scan.ts';

// Summary reads of a classified column name that hold internal data, per file, with the reason. An entry is the read as
// written (`asset.name`, `name`) and covers it in its file.
const ALLOWED: Record<string, Record<string, string>> = {
  'packages/kernel/src/agents.ts': {
    'input.displayName': "an AI agent's display name (crove_kernel.agent.display_name, internal)",
    'agent.display_name': "an AI agent's display name (crove_kernel.agent.display_name, internal)",
  },
  'modules/finance/src/accounts.ts': { name: "the name of an account of the org's chart (crove_finance.org_account.name, internal)" },
  'modules/finance/src/bank.ts': { 'input.bankAccount': 'the chart account code (112x) the statement is for, not a bank account number' },
  'modules/finance/src/cash-voucher.ts': { 'payload.description': "the voucher's description (crove_finance.cash_voucher.description, internal)" },
  'modules/finance/src/journal-voucher.ts': { 'payload.description': "the voucher's description (crove_finance.journal_voucher.description, internal)" },
  'modules/finance/src/reversal.ts': { 'entry.description': "the entry's description (crove_finance.journal_entry.description, internal)" },
  'modules/finance/src/fixed-assets.ts': {
    'input.name': "the asset's name (crove_finance.fixed_asset.name, internal)",
    'asset.name': "the asset's name (crove_finance.fixed_asset.name, internal)",
  },
  'modules/finance/src/year-archive.ts': { detail: 'the count of source documents in the package' },
};

interface Finding {
  file: string;
  line: number;
  read: string;
}

// The top-level arguments of a call's argument list, `(` and `)` included.
function args(call: string): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  let depth = 0;
  let start = 1;
  for (let i = 1; i < call.length - 1; i++) {
    const c = call[i] as string;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push({ at: start, text: call.slice(start, i) });
      start = i + 1;
    }
  }
  out.push({ at: start, text: call.slice(start, call.length - 1) });
  return out;
}

// The code a summary puts into its text: each ${...} of its templates, or the whole summary when it is a plain name or
// member read.
function interpolations(summary: string): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  let end = 0;
  for (const m of summary.matchAll(/\$\{/g)) {
    // A template nested in an interpolation is read with it, once.
    if (m.index < end) continue;
    const inner = balanced(summary, m.index + 1);
    out.push({ at: m.index + 2, text: inner.slice(1, -1) });
    end = m.index + 1 + inner.length;
  }
  if (/^\s*[A-Za-z_$][\w$]*(\s*\??\.\s*[A-Za-z_$][\w$]*)*\s*$/.test(summary)) out.push({ at: 0, text: summary });
  return out;
}

function scan(file: string, text: string, classified: Set<string>): Finding[] {
  const code = blank(text);
  const allowed = ALLOWED[file] ?? {};
  const findings: Finding[] = [];
  const isClassified = (name: string) => classified.has(name) || classified.has(snake(name));
  const lineOf = (at: number) => code.slice(0, at).split('\n').length;
  for (const m of code.matchAll(/\bctx\s*\.\s*activity\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const summary = args(balanced(code, open))[3];
    if (!summary) continue;
    for (const piece of interpolations(summary.text)) {
      // Names read, not called: `party.name` reads name, `wallTime(hours.timeZone, start)` reads timeZone and start.
      for (const read of piece.text.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)(?!\s*[\w$(])/g)) {
        const expr = (read[1] as string).replace(/\s+/g, '');
        const name = expr.split(/\??\./).at(-1) as string;
        if (Object.hasOwn(allowed, expr)) continue;
        if (isClassified(name)) findings.push({ file, line: lineOf(open + summary.at + piece.at + read.index), read: expr });
      }
    }
  }
  return findings;
}

describe('activity summaries and classified columns (#1634)', () => {
  const classified = classifiedColumns();
  const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir)));

  it('scans the sources that write activity', () => {
    const writers = files.filter((f) => /\bctx\s*\.\s*activity\s*\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f).replaceAll('\\', '/'));
    expect(writers).toEqual(expect.arrayContaining(['packages/kernel/src/parties.ts', 'packages/kernel/src/tax-code.ts', 'packages/kernel/src/org-address.ts', 'packages/kernel/src/legal-entities.ts']));
    for (const column of ['name', 'tax_code', 'address', 'email']) expect(classified.has(column)).toBe(true);
  });

  it('finds no summary that reads a classified column', () => {
    const findings = files.flatMap((f) => scan(relative(ROOT, f).replaceAll('\\', '/'), readFileSync(f, 'utf8'), classified));
    expect(findings).toEqual([]);
  });

  it('lists only files that exist and reads they still make', () => {
    for (const [file, entries] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const entry of Object.keys(entries)) expect(text.includes(entry), `${file}: ${entry}`).toBe(true);
    }
  });

  it('fails on a summary that reads a classified column, and passes a neutral one', () => {
    const check = (source: string) => scan('fixture.ts', source, classified).map((f) => f.read);
    expect(check("await ctx.activity('kernel.party', id, 'party.updated', `Đổi tên ${before.name} thành ${name}`);")).toEqual(['before.name', 'name']);
    expect(check("await ctx.activity('kernel.tenant', ctx.orgId, 'org.tax_code_changed', taxCode ? `Đặt mã số thuế là ${taxCode}` : 'Xóa');")).toEqual(['taxCode']);
    expect(check("await ctx.activity('kernel.member', id, 'invite.revoked', invite.email);")).toEqual(['invite.email']);
    expect(check("await ctx.activity('kernel.party', id, 'x', `Gộp ${`(${keep?.name})`}`, { legalEntityId: entity.id });")).toEqual(['keep?.name']);
    // The condition picks the text and is not part of it; a call's result and the record's own fields are not read.
    expect(check("await ctx.activity('kernel.tenant', ctx.orgId, 'org.tax_code_changed', taxCode ? 'Đặt mã số thuế' : 'Xóa mã số thuế');")).toEqual([]);
    expect(check("await ctx.activity('kernel.party', id, 'x', `Đặt lịch ${type.title} lúc ${wallTime(hours.timeZone, start)}`);")).toEqual([]);
    expect(check("await ctx.activity('kernel.party', id, 'x', 'Sửa thông tin'); // ${party.name}")).toEqual([]);
    // Only the summary: the record id, kind and options may name anything.
    expect(check("await ctx.activity('kernel.party', party.name, 'x', 'Sửa', { legalEntityId: entity.name });")).toEqual([]);
  });
});
