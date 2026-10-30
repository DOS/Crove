// SPDX-License-Identifier: AGPL-3.0-only
// The license header check for new source files (#1953): which files it reads, the line it accepts, and the line it asks
// for.
import { describe, expect, it } from 'vitest';
import { checkedPaths, hasHeader, headerFor, missingHeaders } from '../ci/spdx-header.mjs';

describe('SPDX header check', () => {
  it('reads new TypeScript, JavaScript and SQL sources, but not third-party files or other kinds', () => {
    expect(
      checkedPaths([
        'packages/kernel/src/new.ts',
        'apps/app/src/routes/new.tsx',
        'tools/ci/new.mjs',
        'supabase/migrations/20261107000000_crove_kernel_x.sql',
        'supabase/migrations/20261107010000_crove_jobs_pgboss_v47.sql',
        'packages/db/test/invariant/pgtap/pgtap.sql',
        'docs/plan/new.md',
        'apps/app/src/styles.css',
        'packages/agent/test/fixtures/extraction/new.json',
      ]),
    ).toEqual(['packages/kernel/src/new.ts', 'apps/app/src/routes/new.tsx', 'tools/ci/new.mjs', 'supabase/migrations/20261107000000_crove_kernel_x.sql']);
  });

  it('accepts the AGPL-3.0-only line near the top, in the file kind\'s comment', () => {
    expect(hasHeader('// SPDX-License-Identifier: AGPL-3.0-only\n// The module.\nexport {};\n')).toBe(true);
    expect(hasHeader('#!/usr/bin/env node\n// SPDX-License-Identifier: AGPL-3.0-only\n')).toBe(true);
    expect(hasHeader('-- SPDX-License-Identifier: AGPL-3.0-only\r\n-- Crove kernel (issue #1).\r\n')).toBe(true);
    expect(hasHeader('/* SPDX-License-Identifier: AGPL-3.0-only */\n')).toBe(true);
    // Another license, a near miss, a line too far down, or none.
    expect(hasHeader('// SPDX-License-Identifier: MIT\n')).toBe(false);
    expect(hasHeader('// SPDX-License-Identifier: AGPL-3.0-or-later\n')).toBe(false);
    expect(hasHeader('// SPDX-License-Identifier: AGPL-3.0-only-ish\n')).toBe(false);
    expect(hasHeader(`${'// x\n'.repeat(5)}// SPDX-License-Identifier: AGPL-3.0-only\n`)).toBe(false);
    expect(hasHeader('export const a = 1;\n')).toBe(false);
  });

  it('names each new file without the line, and the line to add', () => {
    const files: Record<string, string> = {
      'a.ts': '// SPDX-License-Identifier: AGPL-3.0-only\n',
      'b.ts': 'export {};\n',
      'c.sql': 'SELECT 1;\n',
      'README.md': 'no header\n',
    };
    expect(missingHeaders(Object.keys(files), (path: string) => files[path] ?? '')).toEqual(['b.ts', 'c.sql']);
    expect(headerFor('b.ts')).toBe('// SPDX-License-Identifier: AGPL-3.0-only');
    expect(headerFor('c.sql')).toBe('-- SPDX-License-Identifier: AGPL-3.0-only');
  });
});
