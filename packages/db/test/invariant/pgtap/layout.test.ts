// The listing and layout rule of the pgTAP runner (issue #1643), on a throwaway directory: OS junk is ignored by exact
// name only, and any other unexpected file, a hidden one included, fails the layout. Part of the invariant suite.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { layoutViolations, listTests } from './runner.ts';

describe('the layout of supabase/tests/database', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const tree = (files: string[]) => {
    dir = mkdtempSync(join(tmpdir(), 'crove-pgtap-layout-'));
    for (const file of files) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), '');
    }
    return listTests(dir);
  };

  it('ignores the exact names of OS junk files, at any depth', () => {
    const files = tree(['_ok.test.sql', 'kernel/party.test.sql', '.DS_Store', 'kernel/Thumbs.db', 'kernel/desktop.ini']);
    expect(files).toEqual(['_ok.test.sql', 'kernel/party.test.sql']);
    expect(layoutViolations(files)).toEqual([]);
  });

  it('fails every other unexpected file, hidden ones and near-misses of the junk names included', () => {
    const odd = ['.x.test.sql', '.hidden', 'kernel/.DS_Store.test.sql', '.ds_store', 'thumbs.db', 'notes.md', 'kernel/_x.test.sql', 'unknown/x.test.sql'];
    const files = tree(['_ok.test.sql', ...odd]);
    expect(layoutViolations(files).sort()).toEqual([...odd].sort());
  });
});
