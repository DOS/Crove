// Links shared by both languages. NEXT_PUBLIC_APP_URL points at a running Ludy app (the kernel serves it with the
// sign-in page at /login); without it the sign-in link goes to the hosted app at app.ludy.vn (the owner moved the
// domains from crove.com to ludy.vn and ludy.so on 2026-10-30; ADR-0027).
export const GITHUB_URL = 'https://github.com/DOS/Ludy';
export const DOCS_URL = `${GITHUB_URL}#readme`;
export const SECURITY_URL = `${GITHUB_URL}/blob/main/SECURITY.md`;
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.ludy.vn').replace(/\/+$/, '');
export const SIGN_IN_URL = `${APP_URL}/login`;
export const SITE_URL = 'https://ludy.vn';
