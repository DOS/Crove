// The terms of service and privacy notice links at sign-up and invite acceptance (#688).
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { consentKey, legalLinks } from '../src/lib/legal.ts';

describe('legal links', () => {
  it('shows nothing when the deployment sets neither page', () => {
    const links = legalLinks({});
    expect(links).toEqual({ terms: null, privacy: null });
    expect(consentKey(links)).toBeNull();
    expect(consentKey(legalLinks({ termsUrl: null, privacyUrl: '' }))).toBeNull();
  });

  it('picks the sentence that fits the pages that are set', () => {
    const terms = 'https://crove.example.com/legal/terms';
    const privacy = 'https://crove.example.com/legal/privacy';
    expect(legalLinks({ termsUrl: terms, privacyUrl: privacy })).toEqual({ terms, privacy });
    expect(consentKey(legalLinks({ termsUrl: terms, privacyUrl: privacy }))).toBe('consentBoth');
    expect(consentKey(legalLinks({ termsUrl: terms }))).toBe('consentTerms');
    expect(consentKey(legalLinks({ privacyUrl: privacy }))).toBe('consentPrivacy');
  });

  it('hides anything but an https: page', () => {
    for (const url of ['javascript:alert(1)', 'http://crove.example.com/terms', 'mailto:legal@example.com', 'data:text/html,x', '/terms', 'not a url']) {
      expect(legalLinks({ termsUrl: url, privacyUrl: url }), url).toEqual({ terms: null, privacy: null });
    }
  });

  it('has each sentence in both languages, with the links the component fills', () => {
    for (const messages of [vi, en]) {
      expect(messages.legal.consentBoth).toContain('<terms>');
      expect(messages.legal.consentBoth).toContain('<privacy>');
      expect(messages.legal.consentTerms).toContain('<terms>');
      expect(messages.legal.consentPrivacy).toContain('<privacy>');
    }
  });
});
