import { describe, expect, it } from 'vitest';
import { classify, parseNameStatus } from '../ci/protected-paths.mjs';

type Hit = { path: string; reason: string };
const run = (changes: Array<{ status: string; path: string }>, sql: Record<string, string> = {}): Hit[] =>
  classify(changes, (path: string) => sql[path] ?? '');
const added = (...paths: string[]) => paths.map((path) => ({ status: 'A', path }));
const paths = (hits: Hit[]) => hits.map((h) => h.path);

describe('protected-path detection (G6)', () => {
  it('flags the G6 paths', () => {
    const protectedFiles = [
      '.github/workflows/ci.yml',
      '.githooks/pre-commit',
      'tools/install-git-hooks.mjs',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/hooks/guard.sh',
      'tools/ci/protected-paths.mjs',
      'apps/kernel/test/invariant/kernel-invariants.db.test.ts',
      'packages/db/test/invariant/helper.ts',
      'vitest.invariant.config.ts',
      'packages/kernel-runtime/src/runtime.ts',
      'packages/db/src/context/enter.ts',
      'packages/db/src/index.ts',
      'packages/kernel/src/approval.ts',
      'packages/kernel/src/identity.ts',
      'apps/kernel/src/auth.ts',
      'apps/kernel/src/sessions.ts',
      'apps/web/src/auth/login.tsx',
      'supabase/tests/_rls_matrix.test.sql',
      'AGENTS.md',
      'LICENSE',
      'CLA.md',
      'docs/generated/agent-autonomy.md',
    ];
    expect(paths(run(added(...protectedFiles)))).toEqual(protectedFiles);
  });

  it('leaves ordinary code, docs and tests alone', () => {
    const ordinary = [
      'README.md',
      'docs/plan/crove-os-kernel.md',
      'docs/plan/crove-os-kernel.vi.html',
      'apps/kernel/test/kernel.db.test.ts',
      'apps/kernel/src/http.ts',
      'apps/app/src/routes/inbox.tsx',
      'modules/finance/src/record.ts',
      'packages/kernel/src/commands.ts',
      'packages/db/src/migrate.ts',
      'packages/l10n-vn/src/money.ts',
      'vitest.config.ts',
      'tools/docs-check.mjs',
      '.claude/worktrees/x/AGENTS.md',
      'apps/kernel/src/authority-notes.md',
    ];
    expect(run(added(...ordinary))).toEqual([]);
  });

  it('flags a new migration only when it touches privileges, policies, definers or roles', () => {
    const plain = 'supabase/migrations/20261016000000_crove_finance_add_column.sql';
    const grant = 'supabase/migrations/20261016000001_crove_finance_grants.sql';
    const definer = 'supabase/migrations/20261016000002_crove_kernel_fn.sql';
    const rls = 'supabase/migrations/20261016000003_crove_kernel_table.sql';
    const role = 'supabase/migrations/20261016000004_crove_kernel_role.sql';
    const hits = run(added(plain, grant, definer, rls, role), {
      [plain]: "+ALTER TABLE crove_finance.vendor ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'x';",
      [grant]: '+grant select on crove_finance.vendor to crove_tenant;',
      [definer]: '+CREATE FUNCTION f() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;',
      [rls]: "+SELECT crove_kernel.apply_tenant_rls('crove_kernel.thing');",
      [role]: '+CREATE ROLE crove_reader NOLOGIN;',
    });
    expect(paths(hits)).toEqual([grant, definer, rls, role]);
  });

  it('flags any edited or deleted migration, since applied files never change', () => {
    const file = 'supabase/migrations/20261014130000_crove_kernel_system_context_worker.sql';
    expect(run([{ status: 'M', path: file }])).toEqual([{ path: file, reason: 'migration changed' }]);
    expect(run([{ status: 'D', path: file }])).toEqual([{ path: file, reason: 'migration deleted' }]);
  });

  it('counts both sides of a rename, so moving a file out of a protected path is caught', () => {
    const changes = parseNameStatus(
      [
        'R100\tapps/kernel/test/invariant/kernel-invariants.db.test.ts\tapps/kernel/test/moved.db.test.ts',
        'M\tREADME.md',
        'D\t.github/workflows/protected.yml',
        '',
      ].join('\n'),
    );
    expect(changes).toEqual([
      { status: 'M', path: 'apps/kernel/test/invariant/kernel-invariants.db.test.ts' },
      { status: 'M', path: 'apps/kernel/test/moved.db.test.ts' },
      { status: 'M', path: 'README.md' },
      { status: 'D', path: '.github/workflows/protected.yml' },
    ]);
    expect(paths(run(changes))).toEqual(['apps/kernel/test/invariant/kernel-invariants.db.test.ts', '.github/workflows/protected.yml']);
  });
});
