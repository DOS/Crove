// The modules' entities (plan §5.2 `entities`, #1656) without a database: names, tables the manifest owns, numbered
// entities scoped to a legal entity, and every command's audit target declared. The catalog side (legal_entity_id, the
// append-only trigger, the numbering series) runs in manifest.db.test.ts; here entityProblems() gets planted catalogs.
import { describe, expect, it } from 'vitest';
import { columns, defineModule, type EntityDeclaration } from '@crove/kernel-contract';
import { commandTargetTypes, entityProblems, numberingCalls, type CatalogFacts } from './manifest-entities.ts';
import { MODULE_MANIFESTS, type Manifests } from './manifest-permissions.ts';

describe('module manifests declare their entities (#1656)', () => {
  it('names each entity <module>.<entity> after a table the module owns, and declares every command target', () => {
    const targets = commandTargetTypes();
    expect(targets.problems).toEqual([]);
    expect(targets.uses.length).toBeGreaterThan(50);
    expect(entityProblems(MODULE_MANIFESTS, null, targets.uses)).toEqual([]);
  });

  it('marks an entity legalEntityScoped exactly when its manifest lists legal_entity_id on its table', () => {
    for (const { manifest, file } of Object.values(MODULE_MANIFESTS)) {
      for (const e of manifest.entities) expect(e.legalEntityScoped, `${file}: ${e.type}`).toBe(Object.hasOwn(manifest.tables[`crove_${manifest.id}`]?.[e.table] ?? {}, 'legal_entity_id'));
    }
  });
});

describe('numberingCalls()', () => {
  it('reads a literal doc type, a literal prefix with a column, and refuses any other shape', () => {
    const body = `SELECT a.number INTO v FROM crove_kernel.number_allocate(NEW.org_id, NEW.legal_entity_id, 'finance.cash_voucher.' || NEW.voucher_type, NEW.voucher_date,
                                    'finance.cash_voucher', NEW.id) a;
      PERFORM crove_kernel.number_allocate(NEW.org_id, NEW.legal_entity_id, 'finance.journal_voucher', pg_catalog.date(NEW.created_at), 'finance.journal_voucher', NEW.id);`;
    expect(numberingCalls('crove_finance.v', 'trigger t', body)).toEqual({
      calls: [
        { table: 'crove_finance.v', by: 'trigger t', docType: 'finance.cash_voucher.<voucher_type>', targetType: 'finance.cash_voucher' },
        { table: 'crove_finance.v', by: 'trigger t', docType: 'finance.journal_voucher', targetType: 'finance.journal_voucher' },
      ],
      problems: [],
    });
    const { calls, problems } = numberingCalls('crove_finance.v', 'trigger t', `crove_kernel.number_allocate(NEW.org_id, NEW.legal_entity_id, v_doc_type, NEW.d, 'x.y', NEW.id)`);
    expect(calls).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^trigger t on crove_finance\.v: cannot read its call/);
  });

  it('ignores comments: a quote, comma or parenthesis in one, and a commented-out call', () => {
    const body = `-- the voucher's number (PT, PC): crove_kernel.number_allocate(old, call)
      /* was crove_kernel.number_allocate(NEW.org_id, 'x') */
      PERFORM crove_kernel.number_allocate(NEW.org_id, NEW.legal_entity_id, -- it's the series
        'finance.journal_voucher', NEW.d, /* target (the record) */ 'finance.journal_voucher', NEW.id);
      v := 'a -- b';`;
    expect(numberingCalls('crove_finance.v', 'trigger t', body)).toEqual({
      calls: [{ table: 'crove_finance.v', by: 'trigger t', docType: 'finance.journal_voucher', targetType: 'finance.journal_voucher' }],
      problems: [],
    });
  });
});

describe('entityProblems() on planted mismatches', () => {
  const unnumbered: EntityDeclaration = { type: 'finance.voucher', table: 'voucher', legalEntityScoped: true, audit: 'append_only' };
  const voucher: EntityDeclaration = { ...unnumbered, numbering: { docType: 'finance.voucher.<kind>' } };
  const manifests = (...entities: EntityDeclaration[]): Manifests => ({
    finance: {
      manifest: defineModule({
        id: 'finance',
        tables: { crove_finance: { rule: columns(['org_id', 'id']), voucher: columns(['org_id', 'id', 'kind', 'legal_entity_id']) } },
        permissions: [],
        routes: [],
        nav: [],
        entities,
      }),
      file: 'finance.ts',
    },
  });
  const facts = (over: Partial<CatalogFacts> = {}): CatalogFacts => ({
    columns: new Map([
      ['crove_finance.rule', new Set(['org_id', 'id'])],
      ['crove_finance.voucher', new Set(['org_id', 'id', 'kind', 'legal_entity_id'])],
    ]),
    appendOnly: new Set(['crove_finance.voucher']),
    numbering: [{ table: 'crove_finance.voucher', by: 'trigger n', docType: 'finance.voucher.<kind>', targetType: 'finance.voucher' }],
    ...over,
  });

  it('accepts entities that match their tables and series', () => {
    expect(entityProblems(manifests(voucher, { type: 'finance.rule', table: 'rule', legalEntityScoped: false, audit: 'command' }), facts())).toEqual([]);
  });

  it('fails on a name, a table, or a duplicate', () => {
    expect(entityProblems(manifests({ ...voucher, type: 'crm.voucher' }, { ...voucher, type: 'finance.Voucher', table: 'ledger' }), null)).toEqual([
      'finance.ts: entity crm.voucher is not named finance.<entity>',
      'finance.ts: entity finance.Voucher is not named finance.<entity>',
      'finance.ts: entity finance.Voucher names crove_finance.ledger, which the manifest does not own',
    ]);
    expect(entityProblems(manifests(voucher, voucher), null)).toEqual([
      'finance.ts: entity finance.voucher is also declared in finance.ts',
      'finance.ts: entity finance.voucher names crove_finance.voucher, which entity finance.voucher also names',
    ]);
    const catalog = facts({ columns: new Map([['crove_finance.voucher', new Set(['org_id', 'id', 'kind', 'legal_entity_id'])]]) });
    expect(entityProblems(manifests(voucher, { type: 'finance.rule', table: 'rule', legalEntityScoped: false, audit: 'command' }), catalog)).toEqual([
      'finance.ts: entity finance.rule names crove_finance.rule, which the migrations do not create',
    ]);
  });

  it('fails when legalEntityScoped or audit differs from the table', () => {
    expect(entityProblems(manifests({ type: 'finance.rule', table: 'rule', legalEntityScoped: true, audit: 'append_only' }), facts({ numbering: [] }))).toEqual([
      'finance.ts: entity finance.rule has legalEntityScoped: true, but crove_finance.rule has no legal_entity_id column',
      'finance.ts: entity finance.rule has audit: append_only, but crove_finance.rule is not append-only (crove_kernel.make_append_only)',
    ]);
    expect(entityProblems(manifests({ ...unnumbered, legalEntityScoped: false, audit: 'command' }), facts({ numbering: [] }))).toEqual([
      'finance.ts: entity finance.voucher has legalEntityScoped: false, but crove_finance.voucher has legal_entity_id column',
      'finance.ts: entity finance.voucher has audit: command, but crove_finance.voucher is append-only (crove_kernel.make_append_only)',
    ]);
  });

  it('fails when the numbering differs from the series the triggers allocate', () => {
    expect(entityProblems(manifests({ ...voucher, numbering: { docType: 'finance.voucher' } }), facts())).toEqual([
      'finance.ts: entity finance.voucher is numbered as finance.voucher, but no trigger on crove_finance.voucher allocates that series for target finance.voucher',
      'trigger n on crove_finance.voucher numbers series finance.voucher.<kind> for target finance.voucher, which no entity declares: declare it with numbering in the manifest of crove_finance.voucher',
    ]);
    expect(entityProblems(manifests({ ...voucher, numbering: { docType: 'finance.voucher.<series>' } }), facts()).slice(0, 1)).toEqual([
      'finance.ts: entity finance.voucher numbers by series, which crove_finance.voucher does not have',
    ]);
    expect(entityProblems(manifests(unnumbered), facts())).toEqual([
      'trigger n on crove_finance.voucher numbers series finance.voucher.<kind> for target finance.voucher, which no entity declares: declare it with numbering in the manifest of crove_finance.voucher',
    ]);
    expect(entityProblems(manifests({ type: 'finance.rule', table: 'rule', legalEntityScoped: false, numbering: { docType: 'Finance rule' }, audit: 'command' }), null)).toEqual([
      'finance.ts: entity finance.rule has the malformed doc type Finance rule',
      'finance.ts: entity finance.rule is numbered, but not legalEntityScoped: every number series belongs to a legal entity',
    ]);
  });

  it('fails on a command whose audit target is no entity, but for the listed exceptions', () => {
    const targets = [
      { type: 'finance.voucher', by: 'command finance.voucher.post' },
      { type: 'finance.payslip', by: 'command finance.payslip.issue' },
      { type: 'kernel.user', by: 'command kernel.member.remove' },
    ];
    expect(entityProblems(manifests(voucher), facts(), targets)).toEqual([
      'command finance.payslip.issue names the audit target type finance.payslip, which no manifest declares as an entity',
    ]);
  });
});
