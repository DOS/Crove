// Points git at the repo's .githooks directory. Runs on `pnpm install` (prepare).
// Skips silently outside a git checkout (e.g. CI or Vercel builds from a tarball).
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let isRepoRoot = false;
try {
  // An empty prefix means cwd is this repo's work tree root, not a subfolder of some parent repo.
  isRepoRoot = git('rev-parse', '--show-prefix') === '';
} catch {
  // Not a git checkout, or git is unavailable: nothing to install.
}

if (isRepoRoot) {
  try {
    git('config', 'core.hooksPath', '.githooks');
  } catch {
    console.warn('install-git-hooks: could not set core.hooksPath; local secret scanning is off (CI still scans).');
  }
}
