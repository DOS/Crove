// G5 PII scan (kernel plan §10, issue #1628): this public repository holds no personal data. Test data is synthetic
// (plan §8.7), so a value shaped like a real person's identifier in any tracked file fails the required Docs check.
//
// What it looks for, in every tracked text file:
// - a Vietnamese citizen ID (CCCD): 12 digits, a province prefix that exists, a century and sex digit of 0 to 3;
// - a Vietnamese mobile number: 0, 84 or +84, a carrier prefix in use, 7 more digits, with optional spaces, dots
//   or hyphens between groups;
// - an individual's tax code in a test or fixture file: 10 digits (optionally -NNN) starting with 8 whose check digit
//   is valid (12-digit individual codes are CCCD numbers since Circular 86/2024, covered above);
// - an email address outside the reserved example domains (RFC 2606 and RFC 6761: example.com, example.net,
//   example.org, .test, .example, .invalid, .localhost) and the public addresses on the allowlist.
//
// Values made up on purpose pass without an entry (see looksSynthetic). Anything else that is not personal data goes on
// the allowlist, tools/ci/pii-scan-allowlist.json: each entry names a kind, the paths, domains or values it covers, and a
// reason. It is a protected path (AGENTS.md: tools/ci/**), so an exemption is security-reviewed.
//
// Usage: node tools/ci/pii-scan.mjs [file...]
//   Scans every path git tracks (or only the named files). Exits 1 and names each finding by file, line and kind. The
//   matched value is always masked: the repository is public, and a CI log must not repeat what it found.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Province and city codes of the CCCD's first three digits (Circular 07/2016/TT-BCA, unchanged by the 2025 merger of
// provinces: numbers already issued keep their code).
export const PROVINCES = new Set([
  '001', '002', '004', '006', '008', '010', '011', '012', '014', '015', '017', '019', '020', '022', '024', '025', '026',
  '027', '030', '031', '033', '034', '035', '036', '037', '038', '040', '042', '044', '045', '046', '048', '049', '051',
  '052', '054', '056', '058', '060', '062', '064', '066', '067', '068', '070', '072', '074', '075', '077', '079', '080',
  '082', '083', '084', '086', '087', '089', '091', '092', '093', '094', '095', '096',
]);

// Not part of a longer number, identifier, UUID segment or decimal.
const CCCD = /(?<![\w.-])(\d{3})[0-3]\d{8}(?![\w-]|\.\d)/g;
// Carrier prefixes after the leading 0 (Viettel, MobiFone, VinaPhone, Vietnamobile, Gmobile, Itel, Reddi). The groups
// are checked by mobileShaped: one kind of separator, groups of three digits or more.
const MOBILE = /(?<![\w.+-])(?:\(\+84\)|\+84|84|0)[ .-]?(?:3[2-9]|5[25689]|7[06-9]|8[1-9]|9\d)(?:[ .-]?\d){7}(?![\w-]|\.\d)/g;
const TAX_CODE = /(?<![\w.-])8\d{9}(?:-\d{3})?(?![\w.-])/g;
const EMAIL = /(?<![\w.%])[A-Za-z0-9_][A-Za-z0-9._%+-]*@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![\w-])/g;

// RFC 2606 and RFC 6761: names that never reach a real mailbox.
const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|test|example|invalid|localhost)$/i;
// Where test data lives: an individual's tax code is only looked for there (a company's is public).
const FIXTURE_PATH = /(^|\/)(test|tests|fixtures|__fixtures__|e2e|seed|seeds)\/|\.(test|spec)\.[cm]?[jt]sx?$|(fixture|seed)[^/]*$/i;
// Files that are not text are skipped: a NUL byte in the first 8 KiB.
const BINARY_PROBE = 8192;

const WEIGHTS = [31, 29, 23, 19, 17, 13, 7, 5, 3];
// The tax code check digit, as in packages/l10n-vn/src/tax-code.ts (this script runs with no dependency).
export function taxCheckDigitValid(code) {
  let total = 0;
  for (let i = 0; i < 9; i += 1) total += Number(code[i]) * WEIGHTS[i];
  const check = 10 - (total % 11);
  return check >= 0 && check <= 9 && check === Number(code[9]);
}

// Shown in a log in place of the value: the first characters that say what kind of value it is (a province or carrier
// prefix, the first letter of an address), never enough to find the person.
export function mask(kind, value) {
  if (kind === 'email') {
    const [local, domain] = value.split('@');
    const tld = domain.slice(domain.lastIndexOf('.'));
    return `${local[0]}***@${domain[0]}***${tld}`;
  }
  const digits = value.replace(/\D/g, '');
  return `${digits.slice(0, 3)}${'*'.repeat(digits.length - 3)}`;
}

function digitsOnly(s) {
  return s.replace(/\D/g, '');
}

// How people write a number: 0912345678, 0912 345 678, 091.234.5678, +84 912 345 678, (+84) 912 345 678. Mixed
// separators or short groups are coordinates and colour values ("0.97 0.014 250"), not a phone number.
export function mobileShaped(raw) {
  const match = raw.replace(/^\(\+84\)/, '+84');
  const digits = digitsOnly(match);
  if (digits.length !== (digits.startsWith('0') ? 10 : 11)) return false;
  const separators = new Set(match.replace(/[+\d]/g, ''));
  if (separators.size > 1) return false;
  const groups = match.split(/[ .-]/);
  const [first, ...rest] = groups;
  return (first === '+84' || first === '84' || first.length >= 3) && rest.every((g) => g.length >= 3);
}

// A value made up on purpose: the digits that tell people apart (a CCCD's last six, a phone's last seven) use at most
// two distinct digits (0900000000) or run up or down (0912345678, 0398765432), allowing one break. Write test data
// like that and no allowlist entry is needed.
export function looksSynthetic(tail) {
  if (new Set(tail).size <= 2) return true;
  let up = 0;
  let down = 0;
  for (let i = 1; i < tail.length; i += 1) {
    const step = (Number(tail[i]) - Number(tail[i - 1]) + 10) % 10;
    if (step === 1) up += 1;
    if (step === 9) down += 1;
  }
  return Math.max(up, down) >= tail.length - 2;
}

// `https://user:secret@host` is a URL with credentials, not an email address.
const URL_USERINFO = /:\/\/[^\s/@]*:$/;

// Pure: the findings in one file's text, { line, kind, value }. `path` decides whether tax codes are looked for.
export function scanText(text, path = '') {
  const findings = [];
  const fixture = FIXTURE_PATH.test(path.replaceAll('\\', '/'));
  text.split(/\r?\n/).forEach((content, index) => {
    const line = index + 1;
    for (const m of content.matchAll(CCCD)) {
      if (PROVINCES.has(m[1]) && !looksSynthetic(m[0].slice(6))) findings.push({ line, kind: 'cccd', value: m[0] });
    }
    for (const m of content.matchAll(MOBILE)) {
      if (mobileShaped(m[0]) && !looksSynthetic(digitsOnly(m[0]).slice(-7))) findings.push({ line, kind: 'mobile', value: m[0] });
    }
    if (fixture) {
      for (const m of content.matchAll(TAX_CODE)) {
        if (taxCheckDigitValid(m[0])) findings.push({ line, kind: 'tax-code', value: m[0] });
      }
    }
    for (const m of content.matchAll(EMAIL)) {
      if (!RESERVED_DOMAIN.test(m[1]) && !URL_USERINFO.test(content.slice(0, m.index))) findings.push({ line, kind: 'email', value: m[0] });
    }
  });
  return findings;
}

const underPath = (entryPath, path) => (entryPath.endsWith('/') ? path.startsWith(entryPath) : path === entryPath);
const domainOf = (email) => email.slice(email.indexOf('@') + 1).toLowerCase();
const inDomain = (domain, entry) => domain === entry || domain.endsWith(`.${entry}`);

// Whether one entry exempts a finding: same kind, and each of `paths`, `domains` and `values` the entry names holds
// the finding (a path is exact, or a directory prefix ending in '/'; a domain covers its subdomains).
export function entryAllows(entry, finding, path) {
  return entry.kind === finding.kind &&
    (entry.paths === undefined || entry.paths.some((p) => underPath(p, path))) &&
    (entry.domains === undefined || entry.domains.some((d) => inDomain(domainOf(finding.value), d.toLowerCase()))) &&
    (entry.values === undefined || entry.values.some((v) => v.toLowerCase() === finding.value.toLowerCase()));
}

const KINDS = new Set(['cccd', 'mobile', 'tax-code', 'email']);
const FIELDS = new Set(['kind', 'paths', 'domains', 'values', 'reason']);

// The allowlist's shape: a known kind, at least one non-empty list of paths, domains or values, and a reason someone
// can review. An entry that names nothing would exempt a kind everywhere, so it is refused.
export function allowlistErrors(allowlist) {
  const errors = [];
  if (!Array.isArray(allowlist)) return ['the allowlist is not a JSON array'];
  allowlist.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null) return errors.push(`entry ${i}: not an object`);
    for (const key of Object.keys(entry)) if (!FIELDS.has(key)) errors.push(`entry ${i}: unknown field ${key}`);
    if (!KINDS.has(entry.kind)) errors.push(`entry ${i}: kind must be one of ${[...KINDS].join(', ')}`);
    const lists = ['paths', 'domains', 'values'].filter((k) => entry[k] !== undefined);
    if (lists.length === 0) errors.push(`entry ${i}: names no paths, domains or values`);
    for (const k of lists) {
      if (!Array.isArray(entry[k]) || entry[k].length === 0 || !entry[k].every((v) => typeof v === 'string' && v.length > 0)) errors.push(`entry ${i}: ${k} must be a non-empty list of strings`);
    }
    if (entry.domains !== undefined && entry.kind !== 'email') errors.push(`entry ${i}: domains apply to email only`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) errors.push(`entry ${i}: needs a reason`);
  });
  return errors;
}

// The findings over a set of files, the allowlist applied. `read` returns the text, or null to skip the file.
export function scanFiles(paths, read, allowlist) {
  const findings = [];
  const used = new Set();
  for (const path of paths) {
    const text = read(path);
    if (text === null) continue;
    for (const finding of scanText(text, path)) {
      const entry = allowlist.findIndex((e) => entryAllows(e, finding, path));
      if (entry === -1) findings.push({ path, ...finding });
      else used.add(entry);
    }
  }
  return { findings, unused: allowlist.filter((_, i) => !used.has(i)) };
}

export function readText(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return null; // deleted in the working tree, or a submodule
  }
  if (buf.subarray(0, BINARY_PROBE).includes(0)) return null;
  return buf.toString('utf8');
}

export const ALLOWLIST_FILE = new URL('pii-scan-allowlist.json', import.meta.url);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const allowlist = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
  const errors = allowlistErrors(allowlist);
  for (const e of errors) console.error(`::error file=tools/ci/pii-scan-allowlist.json::${e}`);
  const args = process.argv.slice(2);
  const paths = args.length > 0 ? args : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const { findings } = scanFiles(paths, readText, allowlist);
  for (const f of findings) {
    console.error(`::error file=${f.path},line=${f.line}::${f.path}:${f.line} holds what looks like personal data (${f.kind} ${mask(f.kind, f.value)}); use a synthetic value (an address at example.com, a number that fails the check), or add a reasoned entry to tools/ci/pii-scan-allowlist.json`);
  }
  if (errors.length > 0 || findings.length > 0) process.exitCode = 1;
  else console.log(`pii-scan: ${paths.length} path(s), no personal data found`);
}
