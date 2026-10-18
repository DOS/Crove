// Links shared by both languages. NEXT_PUBLIC_APP_URL points at a running Crove app (the kernel serves it with the
// sign-in page at /login); without it the sign-in link goes to the hosted instance used so far.
export const GITHUB_URL = 'https://github.com/DOS/Crove';
export const DOCS_URL = `${GITHUB_URL}#readme`;
export const SECURITY_URL = `${GITHUB_URL}/blob/main/SECURITY.md`;
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://post.crove.com').replace(/\/+$/, '');
export const SIGN_IN_URL = `${APP_URL}/login`;
export const SITE_URL = 'https://crove.com';
