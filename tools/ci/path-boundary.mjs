// G1 `scope`, the path half (kernel plan §10, #1560): this public repository holds no path that belongs in the private
// crove-cloud repository: OpenTofu or Terraform, environment files with real values, Cloud-only directories and deploy
// workflows. The content half (project refs, internal domains) is the Secret scan job's gitleaks blocklist.
//
// Usage: node tools/ci/path-boundary.mjs
//   Checks every path git tracks in the working tree. Exits 1 and names each offending path with where it belongs.
//   ALLOWED holds the paths kept here on purpose, each with its reason; this file is a protected path (AGENTS.md), so
//   an exemption is security-reviewed.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// What belongs in crove-cloud, by the plan's G1 row.
export const RULES = [
  { name: 'OpenTofu or Terraform', test: (path) => /(^|\/)\.terraform(\.lock\.hcl)?(\/|$)|\.(tf|tfvars|tfstate)(\.backup)?$|\.tf\.json$/.test(path) },
  // Example and template files carry placeholders, never values.
  { name: 'an environment file', test: (path) => /(^|\/)\.env(\.[^/]+)?$/.test(path) && !/\.(example|sample|template)$/.test(path) },
  { name: 'a Cloud-only directory', test: (path) => /^(crove-cloud|cloud|infra)\//.test(path) },
  { name: 'a deploy workflow', test: (path) => /^\.github\/workflows\/[^/]*(deploy|release|terraform|tofu)[^/]*\.ya?ml$/.test(path) },
];

// Paths kept in this repository on purpose, with the reason. Exact paths or a directory prefix ending in '/'.
export const ALLOWED = [
  // The pilot deploy over SSH (#56). The plan places deploy workflows in crove-cloud; until the owner decides where
  // the pilot's deploy lives (#1234's owner items), it stays here, protected (AGENTS.md: tools/deploy/**).
  { path: '.github/workflows/deploy.yml', reason: 'pilot deploy (#56), pending the owner decision listed in #1234' },
];

const allowed = (path) => ALLOWED.some((a) => (a.path.endsWith('/') ? path.startsWith(a.path) : path === a.path));

// Pure: the offending paths among `paths`, each with the rule it breaks.
export function findViolations(paths) {
  const out = [];
  for (const path of paths) {
    if (allowed(path)) continue;
    const rule = RULES.find((r) => r.test(path));
    if (rule) out.push({ path, rule: rule.name });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Past Node's default 1 MiB buffer, which a listing of about 15k paths reaches (#1640).
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
  const violations = findViolations(paths);
  for (const v of violations) {
    console.error(`::error file=${v.path}::${v.path} is ${v.rule}, which belongs in the private crove-cloud repository (G1, kernel plan §10); move it there, or add it to ALLOWED in tools/ci/path-boundary.mjs with a reason`);
  }
  if (violations.length > 0) process.exitCode = 1;
  else console.log(`path-boundary: ${paths.length} tracked path(s), none belongs in crove-cloud`);
}
