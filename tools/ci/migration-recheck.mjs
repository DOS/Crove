// Re-check open pull requests after the base branch moves (issue #251). GitHub does not re-run pull_request checks
// when the base branch changes, so a PR whose new migration was newer than main when its checks ran can fall behind
// while it waits. After every push to the base, this lists the open PRs into it, finds those that add a migration
// that is no longer newer than the base's newest, and re-runs their "Docs check" workflow run. Its Migration order
// step compares against the live base branch, so the required check fails until the author renames the file.
// A re-run replays the workflow file of the original run, so a run from before the Migration order step existed
// would pass again; for those, and when a re-run is refused or a run does not finish in time, the script creates a
// failing "Docs check" check run on the PR head instead, so the required check still blocks the merge.
//
// Trusted code only: the workflow runs this from the base branch on push. PR heads are fetched as git objects and
// read with ls-tree/diff; they are never checked out or executed. Needs GH_TOKEN with actions: write (re-run),
// checks: write (the fallback check run) and pull-requests: read (list), and the full history of the base
// (fetch-depth: 0) for merge bases.
//
// Usage: node tools/ci/migration-recheck.mjs [--dry-run] <base-branch> [base-ref]
//   <base-branch> selects the open PRs (for example main); [base-ref] is the tree to compare with (default HEAD,
//   the pushed commit). --dry-run reports without sending anything. Exits 1 when a PR that fell behind could get
//   neither a re-run nor the fallback check run, so a broken re-check shows up on the push.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { addedMigrations, findStale, git, migrationPaths } from './migration-order.mjs';

const WORKFLOW = 'docs-check.yml';
const ORDER_STEP = 'Migration order';
const REQUIRED_CHECK = 'Docs check'; // the job name, a required check on main
const FALLBACK_TITLE = 'Migration order (base moved)';
const POLL_MS = 20_000;
// Docs check runs still going get up to six minutes in total (the job itself times out at five).
const WAIT_TOTAL_MS = 6 * 60_000;

// Pure: the PRs whose added migrations are not newer than the base's newest.
// `prs` is [{ number, sha, added: [paths] }]; returns [{ number, sha, newest, stale: [paths] }].
export function stalePrs(basePaths, prs) {
  return prs
    .map(({ number, sha, added }) => ({ number, sha, ...findStale(basePaths, added) }))
    .filter((pr) => pr.stale.length > 0);
}

// Pure: what to do with a stale PR's latest Docs check run for its head commit (undefined when there is none).
export function rerunDecision(run) {
  if (!run) return { action: 'skip', reason: 'no Docs check run for the head commit yet; its first run reads the live base' };
  if (run.status !== 'completed') return { action: 'wait', reason: `Docs check run ${run.id} is ${run.status}` };
  if (run.conclusion === 'failure') return { action: 'skip', reason: `Docs check run ${run.id} already fails, so the merge is blocked` };
  if (run.conclusion === 'action_required') return { action: 'skip', reason: `Docs check run ${run.id} waits for a maintainer to approve it` };
  return { action: 'rerun', reason: `Docs check run ${run.id} ended ${run.conclusion}` };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function openPrs(repo, baseBranch) {
  const out = gh(['api', '--paginate', `repos/${repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&per_page=100`, '--jq', '.[] | "\\(.number) \\(.head.sha)"']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [number, sha] = line.split(' ');
      if (!/^\d+$/.test(number) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected PR line: ${line}`);
      return { number: Number(number), sha };
    });
}

function latestRun(repo, sha) {
  const out = gh(['api', `repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=pull_request&head_sha=${sha}&per_page=1`, '--jq', '.workflow_runs[0] // empty | {id, status, conclusion}']);
  return out ? JSON.parse(out) : undefined;
}

// Whether the run's job has the Migration order step: 'yes', 'no', or 'unknown' when the job recorded no steps
// (for example a run cancelled before it started), in which case a re-run is worth trying.
function orderStep(repo, runId) {
  return gh(['api', `repos/${repo}/actions/runs/${runId}/jobs`, '--jq', `[.jobs[].steps[]?.name] | if length == 0 then "unknown" elif any(. == "${ORDER_STEP}") then "yes" else "no" end`]);
}

// Pure: the summary of the fallback check run for a stale PR whose Docs check cannot be re-run usefully.
export function staleSummary(pr) {
  const files = pr.stale.map((path) => `- ${path}`).join('\n');
  return `These migrations are not newer than ${pr.newest}, the newest on the base branch:\n\n${files}\n\nRename each to a version above that (git mv) and push; the new push runs the Docs check again.`;
}

// Whether the newest "Docs check" check run on the commit is already this script's failing fallback, so later pushes
// to main do not stack more copies of it.
function hasFallback(repo, sha) {
  const query = `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(REQUIRED_CHECK)}&filter=latest`;
  const jq = `[.check_runs[] | select(.app.slug == "github-actions")] | sort_by(.started_at) | last | (.conclusion == "failure" and .output.title == "${FALLBACK_TITLE}")`;
  return gh(['api', query, '--jq', jq]) === 'true';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args[0] === '--dry-run';
  const [baseBranch, baseRef = 'HEAD'] = dryRun ? args.slice(1) : args;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!baseBranch || !repo) throw new Error('usage: GITHUB_REPOSITORY=owner/repo node tools/ci/migration-recheck.mjs [--dry-run] <base-branch> [base-ref]');

  const prs = openPrs(repo, baseBranch);
  if (prs.length > 0) {
    git(['fetch', '--no-tags', '--quiet', 'origin', ...prs.map(({ number }) => `+refs/pull/${number}/head:refs/remotes/pull/${number}/head`)]);
  }
  const withAdded = [];
  const skipped = [];
  for (const { number, sha } of prs) {
    const ref = `refs/remotes/pull/${number}/head`;
    // The head moved after the PR list was read: that push gets its own Docs check run against the live base.
    if (git(['rev-parse', ref])[0] !== sha) continue;
    let since;
    try {
      since = git(['merge-base', baseRef, ref])[0];
    } catch {
      skipped.push(`- PR #${number}: no merge base with ${baseBranch}; skipped.`);
      continue;
    }
    withAdded.push({ number, sha, added: addedMigrations(since, ref) });
  }

  const stale = stalePrs(migrationPaths(baseRef), withAdded);
  const lines = [`${prs.length} open PR(s) into ${baseBranch}; ${stale.length} add a migration that is not newer than ${baseBranch}.`, ...skipped];
  let failed = false;
  const deadline = Date.now() + WAIT_TOTAL_MS;
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  // One POST; returns whether it went through (always true in a dry run) and a note for the summary.
  const post = (args, what) => {
    if (dryRun) return [true, `; dry run, no ${what} sent`];
    try {
      gh(['api', '-X', 'POST', ...args]);
      return [true, `; ${what} sent`];
    } catch (error) {
      return [false, `; ${what} FAILED: ${error.message.split('\n')[0]}`];
    }
  };
  for (const pr of stale) {
    let run = latestRun(repo, pr.sha);
    let decision = rerunDecision(run);
    while (decision.action === 'wait' && Date.now() < deadline) {
      await sleep(POLL_MS);
      run = latestRun(repo, pr.sha);
      decision = rerunDecision(run);
    }
    let note = decision.reason;
    let needFallback = false;
    if (decision.action === 'wait') {
      note += ' and did not finish in time';
      needFallback = true;
    } else if (decision.action === 'rerun' && orderStep(repo, run.id) === 'no') {
      note += `, but it predates the ${ORDER_STEP} step, so a re-run would pass again`;
      needFallback = true;
    } else if (decision.action === 'rerun') {
      const [ok, text] = post([`repos/${repo}/actions/runs/${run.id}/rerun`], 're-run request');
      note += text;
      needFallback = !ok;
    }
    // Fallback when the Docs check run cannot be made to fail: a failing check run under the same required name on
    // the PR head. GITHUB_TOKEN creates it as the GitHub Actions app, the app the required check is bound to.
    if (needFallback && hasFallback(repo, pr.sha)) {
      note += `; the failing "${REQUIRED_CHECK}" check run from an earlier re-check is still there`;
    } else if (needFallback) {
      const fields = [`name=${REQUIRED_CHECK}`, `head_sha=${pr.sha}`, 'status=completed', 'conclusion=failure', `output[title]=${FALLBACK_TITLE}`, `output[summary]=${staleSummary(pr)}`, ...(runUrl ? [`details_url=${runUrl}`] : [])];
      const [ok, text] = post([`repos/${repo}/check-runs`, ...fields.flatMap((field) => ['-f', field])], `failing "${REQUIRED_CHECK}" check run`);
      note += text;
      if (!ok) failed = true;
    }
    lines.push(`- PR #${pr.number}: ${pr.stale.join(', ')} not newer than ${pr.newest}. ${note}.`);
  }

  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Migration re-check\n\n${lines.join('\n')}\n`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
