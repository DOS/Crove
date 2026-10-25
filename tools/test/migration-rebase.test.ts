import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planRenames, rebaseMigrations, rewriteReferences } from '../migration-rebase.mjs';

const m = (version: string, name = 'crove_kernel_x') => `supabase/migrations/${version}_${name}.sql`;

describe('migration:rebase plan', () => {
  const base = [m('20261101230000'), m('20261102000000', 'crove_finance_y'), 'supabase/migrations/README.md'];

  it('renames nothing when every new file is already newer than the base', () => {
    expect(planRenames(base, [m('20261102010000'), m('20261102010100', 'crove_kernel_z')])).toEqual([]);
    expect(planRenames(base, [])).toEqual([]);
  });

  it('renames every new file, in order, to whole hours after the base newest, when any is stale', () => {
    // 20261101233000 is stale, 20261102003000 is not; both move so the branch's own order holds.
    expect(planRenames(base, [m('20261102003000', 'crove_kernel_b'), m('20261101233000', 'crove_kernel_a')])).toEqual([
      { from: m('20261101233000', 'crove_kernel_a'), to: m('20261102010000', 'crove_kernel_a') },
      { from: m('20261102003000', 'crove_kernel_b'), to: m('20261102020000', 'crove_kernel_b') },
    ]);
  });

  it('treats a version equal to the base newest as stale, and gives valid UTC times across a day', () => {
    expect(planRenames([m('20261231230000')], [m('20261231230000', 'crove_kernel_a'), m('20261231230100', 'crove_kernel_b')])).toEqual([
      { from: m('20261231230000', 'crove_kernel_a'), to: m('20270101000000', 'crove_kernel_a') },
      { from: m('20261231230100', 'crove_kernel_b'), to: m('20270101010000', 'crove_kernel_b') },
    ]);
  });

  it('rewrites each old version once, even when a new version is another file\'s old one', () => {
    const renames = [
      { from: m('20261102000000', 'crove_kernel_a'), to: m('20261102010000', 'crove_kernel_a') },
      { from: m('20261102010000', 'crove_kernel_b'), to: m('20261102020000', 'crove_kernel_b') },
    ];
    expect(rewriteReferences('see 20261102000000_crove_kernel_a.sql and 20261102010000_crove_kernel_b.sql; 120261102000000 stays', renames)).toBe(
      'see 20261102010000_crove_kernel_a.sql and 20261102020000_crove_kernel_b.sql; 120261102000000 stays',
    );
    expect(rewriteReferences('unchanged', [])).toBe('unchanged');
  });
});

describe('migration:rebase in a repository', () => {
  let dir = '';
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('renames the branch\'s stale migrations, updates their references and stages the result', () => {
    dir = mkdtempSync(join(tmpdir(), 'crove-migration-rebase-'));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    run('config', 'core.hooksPath', join(dir, '.no-hooks'));
    run('config', 'core.autocrlf', 'false');
    write(m('20261101230000'), 'SELECT 1;\n');
    write('docs/notes.md', 'main notes\n');
    run('add', '.');
    run('commit', '-q', '-m', 'base');
    run('checkout', '-q', '-b', 'feature');
    write(m('20261101233000', 'crove_kernel_feature'), 'SELECT 2;\n');
    write('docs/feature.md', 'Adds 20261101233000_crove_kernel_feature.sql.\n');
    run('add', '.');
    run('commit', '-q', '-m', 'feature');
    run('checkout', '-q', 'main');
    write(m('20261102000000', 'crove_finance_other'), 'SELECT 3;\n');
    run('add', '.');
    run('commit', '-q', '-m', 'main moves');
    run('checkout', '-q', 'feature');
    run('merge', '-q', '--no-edit', 'main');

    const lines: string[] = [];
    const renames = rebaseMigrations({ base: 'main', fetch: false, cwd: dir, log: (line: string) => lines.push(line) });
    expect(renames).toEqual([{ from: m('20261101233000', 'crove_kernel_feature'), to: m('20261102010000', 'crove_kernel_feature') }]);
    expect(readFileSync(join(dir, 'docs/feature.md'), 'utf8')).toBe('Adds 20261102010000_crove_kernel_feature.sql.\n');
    expect(readFileSync(join(dir, 'docs/notes.md'), 'utf8')).toBe('main notes\n');
    expect(run('diff', '--cached', '--name-status').trim().split('\n').sort()).toEqual(
      ['M\tdocs/feature.md', `R100\t${m('20261101233000', 'crove_kernel_feature')}\t${m('20261102010000', 'crove_kernel_feature')}`].sort(),
    );
    // A second run finds nothing left to rename once committed.
    run('commit', '-q', '-m', 'rename');
    expect(rebaseMigrations({ base: 'main', fetch: false, cwd: dir, log: () => {} })).toEqual([]);
  }, 60_000);

  it('refuses a dirty tree', () => {
    dir = mkdtempSync(join(tmpdir(), 'crove-migration-rebase-'));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    run('config', 'core.hooksPath', join(dir, '.no-hooks'));
    run('config', 'core.autocrlf', 'false');
    write('a.txt', 'a\n');
    run('add', '.');
    run('commit', '-q', '-m', 'base');
    write('a.txt', 'b\n');
    expect(() => rebaseMigrations({ base: 'main', fetch: false, cwd: dir, log: () => {} })).toThrow(/working tree has changes/);
  }, 60_000);
});
