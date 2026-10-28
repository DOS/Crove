// A note's link to another module's record is checked through that module's get query (#1672). Each name the notes
// module runs must be a query the kernel registers with every module on, or every such link would show as unavailable.
import { describe, expect, it } from 'vitest';
import { NOTE_LINK_TARGETS } from '@crove/kernel-contract';
import { NOTE_TARGET_QUERIES } from '@crove/mod-notes';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';

describe('note link targets (#1672)', () => {
  it('checks every module target through a query the kernel registers', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' });
    const queries = new Set(moduleDefinitions(config).queries.map((q) => q.name));
    const moduleTargets = NOTE_LINK_TARGETS.filter((t) => !t.startsWith('kernel.'));
    expect(Object.keys(NOTE_TARGET_QUERIES).sort()).toEqual([...moduleTargets].sort());
    for (const [target, query] of Object.entries(NOTE_TARGET_QUERIES)) {
      expect(queries.has(query), `${target}: ${query}`).toBe(true);
      // The query belongs to the module that owns the record, so turning that module off makes it not_installed.
      expect(query.split('.')[0], target).toBe(target.split('.')[0]);
    }
  });
});
