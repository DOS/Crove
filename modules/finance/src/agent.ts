// The finance.chief_accountant agent template's program (ADR-0029 Phase 1): Inbox triage plus a review step. The
// kernel creates a proposal_review task for the agent when a proposal is created (the template subscribes to
// kernel.proposal.created). Each run reviews its open tasks: it checks out the task, records what the proposal's
// deterministic checks found, and escalates the approval to the nearest human up the chart (the owner at the root).
// It never posts or approves: posting approval (P09) and signing stay with a qualified human (ADR-0029 section 9).
// Phase 1 uses no language model here; the built-in model runner is a follow-up.
import { DomainError, type AgentProgram } from '@crove/kernel-runtime';

export const CHIEF_ACCOUNTANT_TEMPLATE = 'finance.chief_accountant';
// Tasks one run reviews at most; the rest wait for the next run.
const TASKS_PER_RUN = 20;
const MESSAGE_CHARS = 300;

interface TaskSummary {
  id: string;
  kind: string;
  status: string;
}

interface Check {
  id: string;
  status: string;
  message: string;
}

interface TaskDetail {
  task: { id: string; title: string };
  // checks: null when the proposal's checks could not be read.
  proposal: { id: string; title: string; status: string; checks: Check[] | null } | null;
}

// The review comment: counts and the messages of failed and warning checks. Deterministic, from the checks only. It
// leaves out the proposal's title (#1538). The comment is read with its task, which takes the proposal's legal entity
// (#1762).
export function reviewText(proposal: TaskDetail['proposal']): string {
  if (!proposal) return 'Không tìm thấy đề xuất cần rà soát.';
  if (!proposal.checks) return 'Không đọc được kết quả kiểm tra của đề xuất; cần người rà soát trực tiếp.';
  const failed = proposal.checks.filter((c) => c.status === 'fail');
  const warned = proposal.checks.filter((c) => c.status === 'warn');
  const passed = proposal.checks.filter((c) => c.status === 'pass');
  const lines = [`Kết quả kiểm tra đề xuất: ${passed.length} đạt, ${warned.length} cảnh báo, ${failed.length} không đạt.`];
  for (const c of failed) lines.push(`- Không đạt: ${c.message.slice(0, MESSAGE_CHARS)}`);
  for (const c of warned) lines.push(`- Cảnh báo: ${c.message.slice(0, MESSAGE_CHARS)}`);
  lines.push(failed.length > 0 ? 'Đề nghị kiểm tra lại trước khi duyệt.' : 'Không thấy lỗi chặn; cần người có thẩm quyền duyệt ghi sổ.');
  return lines.join('\n');
}

export const chiefAccountantReview: AgentProgram = async (agent) => {
  const { tasks } = await agent.query<{ tasks: TaskSummary[] }>('kernel.task.list', { status: ['todo', 'in_progress'] });
  for (const task of tasks.filter((t) => t.kind === 'proposal_review').slice(0, TASKS_PER_RUN)) {
    let fence: string;
    try {
      ({ fence } = await agent.execute<{ fence: string }>('kernel.task.checkout', { id: task.id }));
    } catch (error) {
      // Held by someone else or no longer open: not this run's work.
      if (error instanceof DomainError && error.status === 409) continue;
      throw error;
    }
    const detail = await agent.query<TaskDetail>('kernel.task.get', { id: task.id });
    const review = reviewText(detail.proposal);
    await agent.execute('kernel.task.comment', { id: task.id, fence, body: review });
    if (!detail.proposal || detail.proposal.status !== 'pending') {
      await agent.execute('kernel.task.set_status', { id: task.id, fence, status: 'done' });
      continue;
    }
    // Not the proposal's title (#1538); the escalation takes its parent's legal entity (#1762).
    await agent.execute('kernel.task.escalate', { id: task.id, fence, title: 'Duyệt đề xuất đã rà soát', reason: review });
  }
};

export const financeAgentPrograms = { [CHIEF_ACCOUNTANT_TEMPLATE]: chiefAccountantReview } as const;
