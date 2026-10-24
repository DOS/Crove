// Module figures on the multi-client home (#1261), unit part: the composition root names the overview contributions of
// the modules CROVE_MODULES enables, and nothing for a module it leaves out; each names a query its module registers,
// and the kernel's own overview query is built with them. That kernel.org.overview runs them in each org, as the
// member, is in clients-social.db.test.ts.
import { describe, expect, it } from 'vitest';
import { socialOverviewContributions } from '@crove/mod-social';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions, overviewContributions } from '../src/kernel.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };
const configFor = (modules?: string) => loadConfig({ ...base, ...(modules === undefined ? {} : { CROVE_MODULES: modules }) });

describe('overview contributions', () => {
  it('names Social figures when Social is enabled, and none without it', () => {
    expect(socialOverviewContributions).toEqual([{ module: 'social', query: 'social.overview.figures' }]);
    expect(overviewContributions(configFor())).toEqual(socialOverviewContributions);
    expect(overviewContributions(configFor('kernel,social'))).toEqual(socialOverviewContributions);
    expect(overviewContributions(configFor('kernel'))).toEqual([]);
    expect(overviewContributions(configFor('kernel,finance'))).toEqual([]);
  });

  it('names only queries the enabled modules register, and registers the overview query once', () => {
    for (const modules of [undefined, 'kernel', 'kernel,social', 'kernel,finance']) {
      const config = configFor(modules);
      const names = moduleDefinitions(config).queries.map((q) => q.name);
      for (const c of overviewContributions(config)) expect(names).toContain(c.query);
      expect(names.filter((n) => n === 'kernel.org.overview')).toHaveLength(1);
      expect(names.includes('social.overview.figures')).toBe(config.CROVE_MODULES.includes('social'));
    }
  });
});
