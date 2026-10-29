# Runbook: install and rotate the context token key

The context token key (#1822, [ADR-0028](../adr/0028-identity-sessions-and-revocation.md) section 9) binds a user's request context to a session the kernel verified. The kernel signs a short-lived token with it for every user context it enters, and `crove_kernel.enter_user_context` in the database seals the context only for a token that verifies. Since #1822 step 2 the key is required: `crove_app` may no longer call `enter_context`, so raw SQL on that login (an injection, a leaked database password) cannot act as another member, and the app does not start without the key.

This is a different key from the context key that seals `crove.ctx` ([context-key-rotation.md](context-key-rotation.md)), which the database makes itself and no one handles.

## Where the key lives

- `CROVE_CONTEXT_TOKEN_KEY`: base64 of 32 to 64 random bytes, made by `openssl rand -base64 32` on the server (step 1.1) or by the image's `context-token-key` tool, never a passphrase: the app refuses on a public URL a key that decodes to printable text, and the test suites' key in any spelling. It lives in the deployment's environment (`.env` in the stack directory for the compose stack) and in the owner's secret store. The same value goes to the `migrate` step and to the app (`crove`, or `api` and `worker` in the split layout).
- In the database: `crove_kernel.context_token_key`, the current key and at most one previous key, stored as their HMAC pads. Only the migration runner (the `ADMIN_DATABASE_URL` role) and superusers reach it; no login role may read or write it, and no login role may call the installer. On every run `migrate` asks the database whether its current key is the one in its environment (by a signature over a fixed message, not the key) and sends the key only when it is not: a first install or a rotation. It sends it as a bind parameter, never in a statement's text, so it never reaches `pg_stat_statements`, in a transaction that turns parameter and statement logging off for itself when the migration runner is a superuser. A server that logs every parameter in a way the runner cannot turn off (pgaudit, for example) logs the key on that one run: check the database's logging before a rotation if it has such settings. A run with the key already installed sends nothing secret (`context token key unchanged`).
- `CROVE_CONTEXT_TOKEN_KEY_FILE` (the compose stack sets `/data/context-token/key`, on a `context-token` volume of its own, which only `migrate` writes): used when `CROVE_CONTEXT_TOKEN_KEY` is empty. `migrate` creates the file with a fresh random key when it is missing and installs that key; the app only reads it. So a stack that never set the key gets one of its own at its first start after step 2, with no operator step. Losing the file loses nothing else: the next `migrate` makes a new key and installs it (a rotation). Restart the app right after (`docker compose up -d --force-recreate crove`, or `api` and `worker`): a running app keeps the old key, which verifies for only 10 more minutes. A key set in `.env` (section 1) wins over the file.
- Like the context key, the table is ordinary data and travels with every dump, backup and physical replica (see "Copies" below).

## Who does what

- **A person (the owner, or whoever holds the secret store):** approves the production run, and keeps the value in the secret store. The key is generated on the server so that it never passes through a chat, a ticket or an agent's context.
- **The operator who runs the steps** (after that approval): runs the commands below, in order, and stops at the first check that fails.

## Before you start

- Work on the server in the stack directory, as in [secret-rotation.md](secret-rotation.md). Service names are those of the all-in-one layout (`crove`); in the split layout `api` and `worker` take the same setting and `docker compose up -d` restarts both after `migrate`.
- The release that adds the key is deployed: its migration `20261104230000_crove_kernel_context_token.sql` is applied. Check:

  ```bash
  docker compose exec -T db psql -U postgres -tAc "SELECT to_regprocedure('crove_kernel.context_token_key_install(bytea)') IS NOT NULL"
  ```

  Expect `t`. If it prints `f`, deploy that release first ([deploy.md](deploy.md)) and stop here.
- `.env` has the line `CROVE_CONTEXT_TOKEN_KEY=` (a `.env` made from `.env.example` after this release has it). Check, and add it empty if the count is `0`:

  ```bash
  grep -c '^CROVE_CONTEXT_TOKEN_KEY=' .env
  printf 'CROVE_CONTEXT_TOKEN_KEY=\n' >> .env   # only if the count was 0
  ```

- `docker compose up -d` restarts the app (about 15 s on the test stack of secret-rotation.md), so run it at a quiet time.

## 1. Install the key

1. Generate the key on the server and write it into `.env`, without printing it or passing it as a command argument (other users of the server can list arguments with `ps`). This keeps the file's owner and mode:

   ```bash
   ( umask 077; V="$(openssl rand -base64 32)" awk -v k=CROVE_CONTEXT_TOKEN_KEY -F= '$1 == k { print k "=" ENVIRON["V"]; next } { print }' .env > .env.new && cat .env.new > .env && rm .env.new )
   ```

   Check: the line holds a 44-character value (32 bytes in base64):

   ```bash
   grep -c '^CROVE_CONTEXT_TOKEN_KEY=[A-Za-z0-9+/]\{43\}=$' .env   # 1
   ```

   **Person step:** copy the value from `.env` into the secret store (open the file in an editor; do not `cat` it into a shared terminal log).

   Rollback: set the line back to `CROVE_CONTEXT_TOKEN_KEY=` (empty). Nothing has run with the key yet.

2. Apply it: `migrate` runs first and installs the key, then the app restarts with it and checks at boot that the database holds the same key.

   ```bash
   docker compose up -d
   ```

   Check, in order:

   ```bash
   docker compose logs migrate | grep 'context token key'          # context token key installed
   docker compose exec -T db psql -U postgres -tAc "SELECT slot FROM crove_kernel.context_token_key ORDER BY slot"   # current
   docker compose ps                                                # crove (or api and worker) running, not restarting
   curl -s http://127.0.0.1:${PORT:-8080}/readyz                    # {"ready":true}
   docker compose logs --since 10m crove | grep -c 'CONTEXT_TOKEN'  # 0
   ```

   Then sign in once and open a page with data (any org): the request now enters its context through a token. A boot that stops with `CROVE_CONTEXT_TOKEN_KEY is not the key the database holds` means `migrate` did not install this value (check its logs); a log line with `CONTEXT_TOKEN_EXPIRED` means the app's clock is more than 30 seconds ahead of the database's, or 60 seconds or more behind it (fix the servers' time sync).

   Rollback: empty the line in `.env` (`CROVE_CONTEXT_TOKEN_KEY=`) and run `docker compose up -d` again. Before step 2 is deployed, the app goes back to `enter_context`, as before step 1. Once step 2 is deployed, `migrate` takes the key file on the `keys` volume instead (creating it when missing) and installs that key, a rotation, and the app keeps working with it. Before step 2, the installed key stays in the table and does nothing; to remove it as well:

   ```bash
   docker compose exec -T db psql -U postgres -c "DELETE FROM crove_kernel.context_token_key"
   ```

## 2. Rotate the key

When to rotate: the value may have leaked (a copy of `.env` or of the secret store left its place), someone who knew it loses that access, after a restore into another environment (below), or on a schedule if your policy asks for one. Nothing in Ludy expires the key.

1. Write a new value into `.env` with the same command as step 1.1, and check it the same way. **Person step:** replace the value in the secret store, keeping the old one until the last check passes.
2. Apply it with `docker compose up -d`, and run the checks of step 1.2. `migrate` logs `context token key installed`, and the table now holds `current` and `previous`.

The database keeps exactly one previous key and accepts it for 10 minutes after the new key was installed: an app process that still runs with the old key during the restarts keeps working, and its tokens live at most 60 seconds. After 10 minutes the old key verifies nothing, and an app process started with it stops at boot (`CROVE_CONTEXT_TOKEN_KEY is not the key the database holds`). To stop a leaked key at once rather than after 10 minutes, rotate twice in a row (step 2 twice, with two new values): after the second run neither slot holds it.

Rollback: put the old value back in `.env` and run `docker compose up -d`. `migrate` makes it current again and keeps the new one as previous.

## Rolling back past step 2

A rollback restores the images of the release before, never the schema ([deploy.md](deploy.md)): `enter_context` stays revoked from `crove_app`. Step 1's images read the key from `CROVE_CONTEXT_TOKEN_KEY` only, not from the file. So before rolling back from step 2 to step 1 on a stack that runs on the key file, put that key in `.env` (copy it from the file on the `context-token` volume into the `CROVE_CONTEXT_TOKEN_KEY=` line, as in step 1.1, without printing it), or every user request is refused (403). A stack that set the key in `.env` (section 1) needs nothing. A rollback to a release from before step 1 is not supported: its kernel calls `enter_context` and is refused.

## Copies

The table travels with every `pg_dump` run as its owner or a superuser, every base backup and archived WAL, and every physical replica. After restoring production into another environment (staging, a test project, a new self-host), give the copy its own key with two rotations (section 2 twice), so the copy and production no longer share one. To hand a dump to a less trusted place, leave the key out:

```sh
pg_dump --exclude-table-data=crove_kernel.context_token_key ...
```

After restoring such a dump, run `migrate` with the copy's own key before starting the app; until then the app's boot check stops it.

## Deployments without the compose stack

Pass the same value to the migration job and to every app process, as an environment variable from the secret store, and run the migration job first. The checks are the same: the migration job's log line, the slot query as the migration runner, `/readyz`, a sign-in, and no `CONTEXT_TOKEN` errors in the app's logs.

## Tested by

`apps/kernel/test/invariant/context-token.db.test.ts`: a forged, re-signed, expired, other-org or other-key token is refused, a revoked or unrecorded session is refused, a `db`, `jwt` or `off` token must name a recorded session and a `db` one needs Supabase Auth's grants, no login role may call `enter_context` and a runtime without a key is refused, membership is still checked, a rotation keeps exactly one previous key for 10 minutes, the boot check takes the current key only, the runner sends a key only when the database holds another, and no login role reads the table or calls the installer. `apps/kernel/test/context-token-config.test.ts` covers the setting and the token's format. The CI job `split-stack` runs a compose stack with a key generated into the environment and checks that `migrate` installed it; the e2e job's stack uses the key file `migrate` creates.
