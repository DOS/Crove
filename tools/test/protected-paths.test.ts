import { describe, expect, it } from 'vitest';
import { classify, parseNameStatusZ } from '../ci/protected-paths.mjs';

type Hit = { path: string; reason: string };
const paths = (hits: Hit[]) => hits.map((h) => h.path);

describe('protected-path detection (G6)', () => {
  it('flags the G6 paths, the gate itself, dependencies and test runners', () => {
    const protectedFiles = [
      '.github/workflows/ci.yml',
      '.github/CODEOWNERS',
      '.githooks/pre-commit',
      'tools/install-git-hooks.mjs',
      '.gitattributes',
      'supabase/.gitattributes',
      '.gitmodules',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/hooks/guard.sh',
      '.claude/agents/reviewer.md',
      '.mcp.json',
      'CLAUDE.md',
      'AGENTS.md',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      'vitest.config.ts',
      'vitest.invariant.config.ts',
      'tools/ci/protected-paths.mjs',
      'apps/kernel/test/invariant/kernel-invariants.db.test.ts',
      'apps/kernel/test/invariant/fixtures/einvoice-basic.xml',
      'packages/db/test/invariant/migrate.db.test.ts',
      'packages/kernel-runtime/src/runtime.ts',
      'packages/db/src/context/enter.ts',
      'packages/db/src/index.ts',
      'packages/db/src/migrate.ts',
      'packages/kernel/src/approval.ts',
      'packages/kernel/src/identity.ts',
      'apps/kernel/src/auth.ts',
      'apps/kernel/src/sessions.ts',
      'apps/kernel/src/http.ts',
      'apps/web/src/auth/login.tsx',
      'supabase/migrations/20261016000000_crove_finance_add_column.sql',
      'supabase/tests/_rls_matrix.test.sql',
      'LICENSE',
      'CLA.md',
      'docs/generated/agent-autonomy.md',
    ];
    expect(paths(classify(protectedFiles))).toEqual(protectedFiles);
  });

  it('leaves ordinary code, docs and tests alone', () => {
    const ordinary = [
      'README.md',
      'docs/plan/crove-os-kernel.md',
      'docs/plan/crove-os-kernel.vi.html',
      'apps/kernel/test/kernel.db.test.ts',
      'apps/kernel/src/rpc.ts',
      'apps/app/src/routes/inbox.tsx',
      'apps/app/package.json',
      'modules/finance/src/record.ts',
      'packages/kernel/src/commands.ts',
      'packages/l10n-vn/src/money.ts',
      'packages/l10n-vn/test/fixtures/einvoice-basic.xml',
      'tools/docs-check.mjs',
      '.claude/worktrees/x/AGENTS.md',
      'apps/kernel/src/authority-notes.md',
    ];
    expect(classify(ordinary)).toEqual([]);
  });

  it('parses NUL-separated name-status, keeps non-ASCII paths, and counts both sides of a rename', () => {
    const out = [
      'R100',
      'apps/kernel/test/invariant/kernel-invariants.db.test.ts',
      'apps/kernel/test/moved.db.test.ts',
      'M',
      'README.md',
      'A',
      'apps/kernel/test/invariant/hóa đơn "x".db.test.ts',
      'D',
      '.github/workflows/protected.yml',
      '',
    ].join('\0');
    const changed = parseNameStatusZ(out);
    expect(changed).toEqual([
      'apps/kernel/test/invariant/kernel-invariants.db.test.ts',
      'apps/kernel/test/moved.db.test.ts',
      'README.md',
      'apps/kernel/test/invariant/hóa đơn "x".db.test.ts',
      '.github/workflows/protected.yml',
    ]);
    expect(paths(classify(changed))).toEqual([
      'apps/kernel/test/invariant/kernel-invariants.db.test.ts',
      'apps/kernel/test/invariant/hóa đơn "x".db.test.ts',
      '.github/workflows/protected.yml',
    ]);
  });
});
