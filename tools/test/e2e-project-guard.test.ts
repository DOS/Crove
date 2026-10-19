import { describe, expect, it } from 'vitest';
import { resolveComposeProject } from '../../e2e/lib/compose.ts';

describe('e2e database helper project guard (#496)', () => {
  it('uses the shared stack only when nothing points elsewhere', () => {
    expect(resolveComposeProject({})).toBe('crove-e2e');
    expect(resolveComposeProject({ E2E_BASE_URL: 'http://localhost:8080' })).toBe('crove-e2e');
    expect(resolveComposeProject({ E2E_BASE_URL: 'http://localhost:8080/' })).toBe('crove-e2e');
    expect(resolveComposeProject({ E2E_BASE_URL: 'HTTP://LocalHost:8080' })).toBe('crove-e2e');
  });

  it('refuses a non-default E2E_BASE_URL without E2E_COMPOSE_PROJECT', () => {
    expect(() => resolveComposeProject({ E2E_BASE_URL: 'http://localhost:18496' })).toThrow(/Set E2E_COMPOSE_PROJECT/);
    expect(() => resolveComposeProject({ E2E_BASE_URL: 'http://localhost:18496', E2E_COMPOSE_PROJECT: '  ' })).toThrow(/E2E_COMPOSE_PROJECT/);
  });

  it('does not treat a different path or an unparsable URL as the default', () => {
    expect(() => resolveComposeProject({ E2E_BASE_URL: 'http://localhost:8080/Other' })).toThrow(/E2E_COMPOSE_PROJECT/);
    expect(() => resolveComposeProject({ E2E_BASE_URL: 'not a url' })).toThrow(/E2E_COMPOSE_PROJECT/);
  });

  it('accepts an explicit project with any base URL', () => {
    expect(resolveComposeProject({ E2E_BASE_URL: 'http://localhost:18496', E2E_COMPOSE_PROJECT: 'crove-e2e-496' })).toBe('crove-e2e-496');
  });
});
