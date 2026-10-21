// The Content-Security-Policy the kernel sends with the SPA: scripts and styles from its own origin only, connections
// to the auth and storage origins it is given, and Trusted Types enforced with no policy allowed (#681), so a DOM
// sink reached with a string throws.
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../src/http.ts';

const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(' ')]));

describe('the SPA Content-Security-Policy', () => {
  it('enforces Trusted Types for scripts and allows no policy', () => {
    const csp = directives(contentSecurityPolicy('/auth/v1', null));
    expect(csp.get('require-trusted-types-for')).toBe("'script'");
    expect(csp.get('trusted-types')).toBe("'none'");
  });

  it('keeps scripts and styles to its own origin, and adds the auth and storage origins to connect-src only', () => {
    const csp = directives(contentSecurityPolicy('https://auth.example.test/auth/v1', 'https://files.example.test'));
    expect(csp.get('script-src')).toBe("'self'");
    expect(csp.get('style-src')).toBe("'self'");
    expect(csp.get('object-src')).toBe("'none'");
    expect(csp.get('base-uri')).toBe("'none'");
    expect(csp.get('frame-ancestors')).toBe("'none'");
    expect(csp.get('connect-src')).toBe("'self' https://auth.example.test https://files.example.test");
    expect(directives(contentSecurityPolicy('/auth/v1', null)).get('connect-src')).toBe("'self' http://localhost");
  });
});
