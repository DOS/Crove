# Runbook: block or unblock a user account

How the deployment operator blocks a user account in Ludy, and unblocks it (issue #985, ADR-0028 section 2). Use it for an account that abuses the service: mass spam to the inbound address, hammering the API, or a compromised account the owner cannot reach. It does not delete anything, and it does not touch Supabase Auth.

## What it does

- Sets `crove_kernel.user_account.disabled_at` (or clears it), through `crove_kernel.user_set_disabled`, which only the worker login role may run.
- From the next request on, a blocked account is refused with 403 `USER_DISABLED`: every API call, sign-in through the session check, org creation, invite acceptance and the event stream. Its sessions do not need revoking first. Channel credentials and chat alerts that act for the account stop with it.
- Each org the user belongs to gets an audit row `kernel.user.status_note` (system actor `operator`). The row holds whether the account was blocked or unblocked, whether that changed anything, and the reason. The email is never written there. An account in no org is blocked all the same; the command's output is then the only record.
- A second run changes nothing and is noted as unchanged.

## Run it

In the worker's container (it uses `WORKER_DATABASE_URL`), with the account's id or email. The reason is required:

```sh
docker compose run --rm --no-deps worker user-disable spammer@example.com --reason "Mass spam to the inbound address, ticket 123"
docker compose run --rm --no-deps worker user-enable 0190a1b2-0000-7000-8000-000000000001 --reason "Owner confirmed the account is theirs again"
```

On success it prints one line, for example `[user-disable] account <id> is now disabled; noted in 2 org(s)`, and exits 0. It exits 2 when the arguments are wrong, when no account matches, or when several accounts share the email (accounts from different identity providers). In that case, run it again with the account id.

## Afterwards

- Tell the org owners why, outside Ludy. Their audit log shows the note with the reason.
- On self-host with the bundled Supabase Auth, the user can still sign in there, but every Ludy request is refused. To stop sign-ins at the source too, ban the user in Supabase Auth as well.
- Unblocking does not restore sessions the user signed out of. They sign in again.
