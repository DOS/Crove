// The `user-disable` and `user-enable` image roles (issue #985, ADR-0028 section 2): the deployment operator blocks a
// user account in Crove, or unblocks it, without touching Supabase Auth. Run in the worker's container (the worker
// login is the only role that may execute crove_kernel.user_set_disabled), like exports-rebind:
//
//   user-disable <account id or email> --reason <text>
//   user-enable  <account id or email> --reason <text>
//
// A disabled account is refused on its next request with 403 USER_DISABLED (session_check and the org-less checks read
// user_account.disabled_at), whatever its sessions. Each org the user belongs to gets an audit row with the reason
// (kernel.user.status_note); no email is written there. A repeated run changes nothing and is noted as unchanged.
// Exit codes: 0 done, 2 the command could not run (arguments, unknown or ambiguous account, database).
import { sql } from 'kysely';
import type { Actor, Runtime } from '@crove/kernel-runtime';

export const USER_DISABLE_EXIT = { ok: 0, failed: 2 } as const;

const OPERATOR: Actor = { type: 'system', component: 'operator' };

export interface UserDisableArgs {
  ref: string;
  reason: string;
}

export function parseUserDisableArgs(argv: readonly string[]): UserDisableArgs {
  let ref: string | null = null;
  let reason: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--reason') {
      reason = (argv[++i] ?? '').trim();
      if (reason === '' || reason.length > 500) throw new Error('--reason needs a text of 1 to 500 characters');
    } else if (arg?.startsWith('--')) {
      throw new Error(`unknown argument ${arg}; use <account id or email> --reason <text>`);
    } else if (ref === null && arg) {
      ref = arg.trim();
    } else {
      throw new Error('name one account: <account id or email> --reason <text>');
    }
  }
  if (!ref || ref.length > 320) throw new Error('name the account: its id or its email');
  if (reason === null) throw new Error('--reason is required: it goes into the audit log of every org the user belongs to');
  return { ref, reason };
}

const OUTCOMES: Record<string, string> = {
  invalid: 'name the account: its id or its email',
  not_found: 'no account has this id or email',
  ambiguous: 'several accounts share this email; name the account id instead',
};

export interface UserStatusResult {
  userId: string;
  changed: boolean;
  disabledAt: Date | null;
  orgs: number;
}

// Sets or clears disabled_at, then notes it in every org of the user. The note runs per org through execute(), after
// the account changed: a failed note is reported and the command can be run again (it then notes "unchanged").
export async function setUserDisabled(runtime: Pick<Runtime, 'orgless' | 'execute'>, disabled: boolean, args: UserDisableArgs): Promise<UserStatusResult> {
  const row = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ outcome: string; user_id: string | null; changed: boolean | null; disabled_at: Date | null; org_ids: string[] | null }>`
      SELECT outcome, user_id, changed, disabled_at, org_ids FROM crove_kernel.user_set_disabled(${args.ref}, ${disabled})`.execute(db);
    return rows[0];
  });
  if (!row) throw new Error('crove_kernel.user_set_disabled returned no row');
  if (row.outcome !== 'ok' || !row.user_id || !row.org_ids) throw new Error(OUTCOMES[row.outcome] ?? `unexpected outcome ${row.outcome}`);
  for (const orgId of row.org_ids) {
    await runtime.execute('kernel.user.status_note', { userId: row.user_id, disabled, changed: row.changed === true, reason: args.reason }, { actor: OPERATOR, orgId });
  }
  return { userId: row.user_id, changed: row.changed === true, disabledAt: row.disabled_at, orgs: row.org_ids.length };
}

export interface UserDisableDeps {
  runtime: Pick<Runtime, 'orgless' | 'execute'>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export async function runUserDisable(deps: UserDisableDeps, disabled: boolean, argv: readonly string[]): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const role = disabled ? 'user-disable' : 'user-enable';
  let args: UserDisableArgs;
  try {
    args = parseUserDisableArgs(argv);
  } catch (e) {
    error(`[${role}] ${e instanceof Error ? e.message : String(e)}`);
    return USER_DISABLE_EXIT.failed;
  }
  try {
    const result = await setUserDisabled(deps.runtime, disabled, args);
    const state = disabled ? 'disabled' : 'enabled';
    log(`[${role}] account ${result.userId} ${result.changed ? `is now ${state}` : `was already ${state}`}; noted in ${result.orgs} org(s)`);
    return USER_DISABLE_EXIT.ok;
  } catch (e) {
    error(`[${role}] ${oneLine(e instanceof Error ? e.message : String(e))}`);
    return USER_DISABLE_EXIT.failed;
  }
}
