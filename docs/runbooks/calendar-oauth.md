<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: outside calendars (Google Calendar)

A member connects a Google account from Settings, "Lịch ngoài". The busy times of its primary calendar (start and end only: never a title, never an attendee) block that member's booking slots, and the worker refreshes them every 15 minutes (#1374, #2123). This runbook is for any operator who brings their own Google OAuth app. Steps specific to one operator's cloud project, secret store or domain belong in that operator's private deployment layer, not here.

With no app configured the connect button is hidden and nothing else changes: `docker compose up` needs no external account.

## What you need

- A Google Cloud project with the **Google Calendar API** enabled.
- An **OAuth client of type "Web application"** in that project.
- An OAuth consent screen with the scopes `openid`, `email` and `https://www.googleapis.com/auth/calendar.freebusy`. The free/busy scope is a sensitive scope: Google verifies the app before more than 100 users outside the project's organization can connect (until then the project is "in testing" and each member must be listed as a test user; a test-mode grant also expires after 7 days).
- Optional, for write-back of bookings (a member's confirmed bookings become events in their Google calendar): also the scope `https://www.googleapis.com/auth/calendar.events.owned` on the consent screen (insert, change and delete events on calendars the account owns, which covers its primary calendar; the broader `calendar.events` would also reach every calendar shared with the account, so it is not used). Both written events are `private` and `opaque`, so people the member shares their calendar with see a busy block without the visitor's name. It is a sensitive scope too. Without it members can still connect for free/busy; the write-back switch then asks them to connect again once the scope is on the screen.
- The server's `PUBLIC_URL` is `https`, and `CREDENTIAL_KEY` is set (`credential-key.md`): without a key a token could never be sealed, and the connect is refused before the member leaves the app.

The client is its own: do not reuse the YouTube or Business Profile client (`CHANNEL_GOOGLE_*`), whose consent screen and scopes differ.

## Steps

Each step has a check and a rollback. Never write a secret, a project id or an internal host into an issue, a PR or a file of the repository: name where it comes from.

1. **Create the OAuth client.** Google Cloud console, APIs and services, Credentials, Create credentials, OAuth client ID, Web application. Add the authorized redirect URI `<PUBLIC_URL>/calendar/oauth/google_calendar/callback`, exactly, with no trailing slash.
   - Check: the client shows the redirect URI; the Calendar API shows as enabled.
   - Rollback: delete the client.
2. **Set the consent screen scopes** to the three above and the app name and support address members will see.
   - Check: the consent screen lists `calendar.freebusy` and nothing broader.
   - Rollback: remove the scope.
3. **Give the server the client.** Set `CALENDAR_GOOGLE_CLIENT_ID` and `CALENDAR_GOOGLE_CLIENT_SECRET` on the API and the worker (both read them: the API starts the connect, the worker syncs), from the operator's secret store. Set both or neither: the server refuses to start with one. Restart both.
   - Check: in Settings, the working-hours card shows a "Kết nối Google Calendar" button.
   - Rollback: unset both variables and restart. The button hides, the worker stops syncing, existing connections and their busy blocks stay until the member disconnects or reconnects.
4. **Connect a test account.** As a member (not a viewer), press the button, accept the consent screen, and come back to Settings.
   - Check: the account is listed with "Chưa đồng bộ"; within 15 minutes it reads "Đồng bộ lần cuối ..." and an event in that calendar takes its slot off the member's booking page.
   - Rollback: "Ngắt kết nối" deletes the account's busy blocks and hides the account at once; within 15 minutes the worker revokes the grant at Google (https://oauth2.googleapis.com/revoke, with the refresh token), then drops the sealed token and the row. If Google cannot be reached for 3 days, or the token can no longer be opened (the member left, the key is gone), the connection is removed anyway and the audit row says `revoked: false` with the reason: remove the app's access on the Google account's security page in that case.

## Writing bookings to the member's calendar (write-back)

A member who turns on "Ghi lịch hẹn vào lịch này" under a connected Google calendar (it asks them to connect again when the grant lacks the events scope) gets each confirmed booking as an event in their primary calendar, titled with the event type and the visitor's name: the visitor's name is the only personal data that leaves for Google, into the member's own calendar; no email, phone or attendee. The worker writes it within seconds of the booking (a job the outbox relay queues from the booking's confirmed, moved or cancelled event, queue `kernel-calendar-writeback`; it never renews a token), and the 15 minute sweep repeats the same reconcile as the backstop (a lost job, a token about to run out, a refused token, which only the sweep renews or expires). It moves it when the booking moves and deletes it when the booking is cancelled; each call is idempotent by an event id the kernel derives, so a retry never makes a second event. An event the member deletes by hand stays deleted until its booking changes. Disconnecting a calendar cannot call Google for its events (the token goes), so events already written stay in the member's calendar. Check: turn it on for a test account, make a booking, and within seconds the event is there (at the latest at the next sweep, 15 minutes), on the account's primary calendar (this live round trip also confirms that the `calendar.events.owned` scope covers `primary`; if Google answers 403, the scope is not enough and the switch must not be offered); cancel the booking and it goes. Rollback: the member turns the switch off (writes stop at once, also in a sweep that is running). Removing the events scope from the consent screen does not revoke grants that already carry it; to stop write-back for everyone, a staff step sets `write_back = false` on the connections.

## When something goes wrong

- **Closing an organization.** An organization being offboarded is not swept: its calendar connections, sealed tokens and addresses stay until the org purge deletes them, and their grants are never revoked (a disconnect made once `kernel.org.offboard` has run is marked but not finished, and only owners can enter an offboarding org). Before running the offboard, have every member disconnect their calendar and wait 15 minutes for the sweep: the audit rows of `kernel.calendar.finish_disconnect` confirm each one. Reopening the org (a staff step) lets the sweep take its connections up again.

- **The button is missing.** Both `CALENDAR_GOOGLE_*` variables are set on the API, `CREDENTIAL_KEY` is set, and the user is not a viewer.
- **"Quyền truy cập đã bị thu hồi hoặc hết hạn".** Google refused the grant (the member revoked the app, or a test-mode grant ran 7 days). The sealed token is dropped; the member connects again. The busy blocks stay until then, so time that may still be busy is not offered.
- **"Lần đồng bộ gần nhất gặp lỗi".** A passing failure (a quota, an outage); the next sweep retries. The log line is `[calendar-sync] connection <id prefix>` with an error name, never a token.
- **Rotating `CREDENTIAL_KEY`.** Calendar tokens are sealed like channel tokens. Keep `CREDENTIAL_KEY_PREVIOUS` until members have reconnected: a calendar token the server can no longer open expires the connection (`credential_unreadable`) and the member connects again. The key reseal sweep and the key counts of `credential-key.md` do not cover calendar tokens yet (tracked as a follow-up): a connection renews its own envelope under the current key at its next token refresh, but the dormant one of a member who left stays under the old key, so do not retire `CREDENTIAL_KEY_PREVIOUS` on the strength of those counts alone.
- **Rotating the client secret.** Create a second secret in the Google console, set it on the API and the worker, restart, then delete the old one. Existing connections keep working: they hold refresh tokens, not the secret.
