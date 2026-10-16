// Alert de-duplication for the prober (issue #151). A probe result goes out only when it is news: a new problem, a
// changed one (another set of failing checks), a resolved one, or the same problem again once the repeat interval
// (ALERT_REPEAT_MINUTES) has passed. A problem is the sorted names of the failing checks; the values (ages, counts)
// do not count, so a backlog that keeps growing is one problem.
//
// Two gates with the same rules:
//   pgAlertGate      the deployment-wide state in crove_kernel.prober_alert_state, through prober_alert_gate(). It
//                    survives restarts and is shared by every prober on the database. The row stays locked from the
//                    decision until settle(): a delivered alert commits, a failed one rolls back (the next probe
//                    tries again), and a second prober that probes meanwhile is told 'busy' and sends nothing.
//   memoryAlertGate  in-process state for the one problem the database cannot record: the database itself being
//                    unreachable. A looping prober (--every) keeps it between probes; a cron run starts empty.
import pg from 'pg';

export type GateDecision = 'healthy' | 'new' | 'changed' | 'repeat' | 'resolved' | 'suppressed' | 'busy';

export interface GateResult {
  decision: GateDecision;
  // The state before this decision.
  previousProblem: string | null;
  problemSince: Date | null;
  lastNotifiedAt: Date | null;
}

export interface AlertGate {
  /** Decides whether `problem` (null: healthy) is worth a notification. Call settle() afterwards, always. */
  decide(problem: string | null, now: Date): Promise<GateResult>;
  /** Records the decision when `delivered`, forgets it otherwise, and releases the state. Never throws. */
  settle(delivered: boolean): Promise<void>;
}

/** The problem key of a set of failing checks: sorted, unique, comma-separated; null when nothing fails. */
export function problemKey(checks: readonly string[]): string | null {
  const unique = [...new Set(checks)].sort();
  return unique.length === 0 ? null : unique.join(',');
}

const MIN_REPEAT_SECONDS = 60;
const MAX_REPEAT_SECONDS = 604_800;

export interface GateState {
  problem: string | null;
  startedAt: Date | null;
  notifiedAt: Date | null;
}

/**
 * The decision rules, shared by the memory gate and mirrored by crove_kernel.prober_alert_gate(). repeatSeconds 0
 * never repeats; other values are clamped to 60 s..7 d like the SQL function does.
 */
export function decideAlert(state: GateState, problem: string | null, now: Date, repeatSeconds: number): { result: GateResult; next: GateState } {
  const before = { previousProblem: state.problem, problemSince: state.startedAt, lastNotifiedAt: state.notifiedAt };
  const repeatMs = repeatSeconds > 0 ? Math.min(Math.max(repeatSeconds, MIN_REPEAT_SECONDS), MAX_REPEAT_SECONDS) * 1000 : null;
  if (problem === null) {
    if (state.problem === null) return { result: { decision: 'healthy', ...before }, next: state };
    return { result: { decision: 'resolved', ...before }, next: { problem: null, startedAt: null, notifiedAt: now } };
  }
  if (state.problem === null) return { result: { decision: 'new', ...before }, next: { problem, startedAt: now, notifiedAt: now } };
  if (state.problem !== problem) return { result: { decision: 'changed', ...before }, next: { ...state, problem, notifiedAt: now } };
  if (repeatMs !== null && (state.notifiedAt === null || now.getTime() - state.notifiedAt.getTime() >= repeatMs)) {
    return { result: { decision: 'repeat', ...before }, next: { ...state, notifiedAt: now } };
  }
  return { result: { decision: 'suppressed', ...before }, next: state };
}

export function memoryAlertGate(repeatSeconds: number): AlertGate {
  let state: GateState = { problem: null, startedAt: null, notifiedAt: null };
  let pending: GateState | null = null;
  return {
    async decide(problem, now) {
      const { result, next } = decideAlert(state, problem, now, repeatSeconds);
      pending = next;
      return result;
    },
    async settle(delivered) {
      if (delivered && pending) state = pending;
      pending = null;
    },
  };
}

const DECISIONS = new Set<GateDecision>(['healthy', 'new', 'changed', 'repeat', 'resolved', 'suppressed', 'busy']);

/**
 * The deployment-wide gate over PROBER_DATABASE_URL (crove_prober). Its own connection holds one transaction from
 * decide() to settle(); the server ends it after 60 s idle, so a prober that hangs mid-delivery cannot keep the row.
 */
export function pgAlertGate(databaseUrl: string, repeatSeconds: number): AlertGate {
  let client: pg.Client | null = null;
  const close = async () => {
    const c = client;
    client = null;
    await c?.end().catch(() => {});
  };
  return {
    async decide(problem) {
      const c = new pg.Client({
        connectionString: databaseUrl,
        application_name: 'crove-prober',
        connectionTimeoutMillis: 10_000,
        statement_timeout: 10_000,
        idle_in_transaction_session_timeout: 60_000,
      });
      c.on('error', () => {});
      client = c;
      try {
        await c.connect();
        await c.query('BEGIN');
        const { rows } = await c.query<{ decision: string; previous_problem: string | null; problem_since: Date | null; last_notified_at: Date | null }>(
          'SELECT decision, previous_problem, problem_since, last_notified_at FROM crove_kernel.prober_alert_gate($1::text, $2::int)',
          [problem, repeatSeconds],
        );
        const row = rows[0];
        if (!row || !DECISIONS.has(row.decision as GateDecision)) throw new Error('crove_kernel.prober_alert_gate() returned no decision');
        return {
          decision: row.decision as GateDecision,
          previousProblem: row.previous_problem,
          problemSince: row.problem_since,
          lastNotifiedAt: row.last_notified_at,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
    async settle(delivered) {
      const c = client;
      if (!c) return;
      try {
        await c.query(delivered ? 'COMMIT' : 'ROLLBACK');
      } catch {
        // A failed commit leaves the state as it was: the next probe sends again, which is the safe side.
      } finally {
        await close();
      }
    },
  };
}
