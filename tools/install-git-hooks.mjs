// Points git at the repo's .githooks directory. Runs on `pnpm install` (prepare).
// Skips silently outside a git checkout (e.g. CI or Vercel builds from a tarball).
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // Not a git checkout, or git is unavailable: nothing to install.
}
