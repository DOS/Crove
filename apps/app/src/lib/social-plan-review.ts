// One client review link for a content plan (#902): the next month to suggest, the address the client opens, and how
// far the client got through the plan.

const pad = (n: number) => String(n).padStart(2, '0');
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The days a plan usually covers: from today to the same day next month, as date inputs.
export function nextMonth(now: Date): { from: string; to: string } {
  const last = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate() - 1);
  return { from: dateInput(now), to: dateInput(last) };
}

// The page a client opens, plan or single post alike; the token stays after the #, so browsers never send it to a
// server in the address.
export const reviewUrl = (origin: string, token: string) => `${origin}/-/review#${token}`;

// The most posts one plan link covers (REVIEW_PLAN_POSTS_MAX on the server).
export const PLAN_POSTS_MAX = 50;

interface PlanPostState {
  gone: boolean;
  feedback?: readonly { verdict: string }[];
}

// How far the client got: the posts still in the plan, and those of them with an "Approved" or "Needs changes"
// answer (a comment alone is no answer).
export function planProgress(posts: readonly PlanPostState[]): { total: number; answered: number; gone: number } {
  const live = posts.filter((p) => !p.gone);
  return {
    total: live.length,
    answered: live.filter((p) => (p.feedback ?? []).some((f) => f.verdict === 'approved' || f.verdict === 'changes_requested')).length,
    gone: posts.length - live.length,
  };
}
