// The social.content_manager agent template's program (#799, plan line 19, ADR-0029 Phase 1): a pre-review of posts
// sent for review. social.post.submitted carries an agent_task, so the kernel gives the agent a task for each post
// sent (the template subscribes to the event). Each run checks out its open post tasks, comments what the
// deterministic checks of social.post.pre_review found (each waiting channel's rule issues, the brand voice's words
// to avoid, images without a description) and escalates the review to the nearest human up the chart. It never
// approves, publishes or edits a post: publishing stays R2 with a person. Phase 1 uses no language model.
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { DomainError, type AgentProgram, type CommandContext } from '@crove/kernel-runtime';

export const CONTENT_MANAGER_TEMPLATE = 'social.content_manager';
// Tasks one run reviews at most; the rest wait for the next run.
const TASKS_PER_RUN = 20;

export interface PreReview {
  postId: string;
  title: string;
  // Channels still waiting for a decision.
  waiting: number;
  findings: string[];
}

// The task the kernel makes from social.post.submitted (#799): its title, the post it is about and the post's taint.
export function preReviewTask(post: { id: string; title: string | null; body: string; tainted: boolean }) {
  const name = (post.title?.trim() || post.body.replace(/\s+/g, ' ').trim() || 'bài không có chữ').slice(0, 120);
  return { title: `Rà soát bài: ${name}`.slice(0, 300), ref: { type: 'social.post', id: post.id }, tainted: post.tainted };
}

// The agent task of a post sent for review by any path (#816: evergreen repeats, publishing and policy re-submits as
// well as a person's submit), read from the post; a post that cannot be read gives none, and its taint defaults to true.
export async function agentTaskOf(ctx: Pick<CommandContext, 'trx' | 'orgId'>, postId: string): Promise<ReturnType<typeof preReviewTask> | undefined> {
  const post = await ctx.trx.selectFrom('crove_social.post').select(['id', 'title', 'body', 'tainted']).where('org_id', '=', ctx.orgId).where('id', '=', postId).executeTakeFirst();
  return post ? preReviewTask({ id: post.id, title: post.title, body: post.body, tainted: post.tainted ?? true }) : undefined;
}

// The review comment: what the checks found, or that they found nothing blocking. Deterministic.
export function preReviewText(r: PreReview): string {
  const lines = [`Rà soát trước bài "${r.title || 'không có chữ'}": ${r.waiting} kênh đang chờ duyệt.`];
  if (r.findings.length === 0) lines.push('Không thấy lỗi theo các kiểm tra tự động; cần người có quyền duyệt xem và quyết định.');
  else {
    for (const f of r.findings) lines.push(`- ${f}`);
    lines.push('Đề nghị người duyệt xem các điểm trên trước khi quyết định.');
  }
  return lines.join('\n');
}

interface TaskSummary {
  id: string;
  kind: string;
  status: string;
  source: string;
  sourceRef: unknown;
}

const zPostRef = z.object({ type: z.literal('social.post'), id: zId });

export const contentManagerReview: AgentProgram = async (agent) => {
  const { tasks } = await agent.query<{ tasks: TaskSummary[] }>('kernel.task.list', { status: ['todo', 'in_progress'] });
  const mine = tasks.filter((t) => t.kind === 'general' && t.source === 'event' && zPostRef.safeParse(t.sourceRef).success).slice(0, TASKS_PER_RUN);
  for (const task of mine) {
    const ref = zPostRef.parse(task.sourceRef);
    let fence: string;
    try {
      ({ fence } = await agent.execute<{ fence: string }>('kernel.task.checkout', { id: task.id }));
    } catch (error) {
      // Held by someone else or no longer open: not this run's work.
      if (error instanceof DomainError && error.status === 409) continue;
      throw error;
    }
    let review: PreReview;
    try {
      review = await agent.query<PreReview>('social.post.pre_review', { postId: ref.id });
    } catch (error) {
      // The post is gone: nothing to review.
      if (error instanceof DomainError && error.status === 404) {
        await agent.execute('kernel.task.set_status', { id: task.id, fence, status: 'done' });
        continue;
      }
      throw error;
    }
    const text = preReviewText(review);
    await agent.execute('kernel.task.comment', { id: task.id, fence, body: text });
    // Decided already (a one-step approval, or a person was quicker): nothing to hand on.
    if (review.waiting === 0) {
      await agent.execute('kernel.task.set_status', { id: task.id, fence, status: 'done' });
      continue;
    }
    await agent.execute('kernel.task.escalate', { id: task.id, fence, title: `Duyệt bài: ${review.title || 'không có chữ'}`.slice(0, 300), reason: text });
  }
};

export const socialAgentPrograms = { [CONTENT_MANAGER_TEMPLATE]: contentManagerReview } as const;
