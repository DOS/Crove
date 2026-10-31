# 0024. The kernel calendar service and the CRM booking feature

- Status: accepted (plan Decision 20 and docs/plan/calendar.md; recorded after C1 to C5 and C8 were built)
- Date: 2026-10-25
- Deciders: owner (JOY), through plan Decision 20 and the [Calendar plan](../plan/calendar.md)
- Builds on: plan §13 ("Calendar lives in CRM"), ADR-0025 (channel layer: connections, sealed credentials, `external_call`), ADR-0028 (every route through `authenticate()` unless on the reasoned public list), ADR-0031 (module enablement), ADR-0034 (the kernel mail pipeline)
- Tracking: #1383. Built in C1 #1313, C2 #1314, C3 #1318, C4 #1319, C5 #1320, C8 #1373 and the Turnstile check #1353; open: C6 #1374, C7 #1375, the booking feed #1382

## Context and problem statement

The kernel plan puts Calendar in Phase 3 with CRM and asks for this ADR "before Phase 3" (§16, the ADR table). On 2026-10-24 the owner started Calendar early, as an exception to Decision 2 (Decision 20), with the structure of §13: the core (events, availability, free/busy) is a kernel `calendar` service that HRM (interviews, leave) and Service (customer appointments) will share, and the Calendly-style booking page is a feature of the `crm` module. Steps C1 to C5 and the team event types of C8 were built from the Calendar plan before this record was written.

The questions: what the kernel owns and what `crm` owns, how times are stored, how the database prevents a double booking on PostgreSQL 17 with no extension, how slots are computed, how a visitor without an account books, changes and cancels safely, and what external calendars and meeting links will need.

## Decision

1. **The split.** The kernel owns each member's working hours and calendar events, the Vietnamese holiday list and the slot functions; it offers them to every module (`packages/kernel/src/calendar.ts`: `kernel.calendar.get`, `kernel.calendar.slots`, `kernel.calendar.hours.save`, `kernel.calendar.event.add`, `kernel.calendar.event.cancel`, and `workingHoursOf()` and `busyOf()` for modules). The `crm` module (`modules/crm`, schema `crove_crm`) owns event types, bookings, the public booking page and the "Lịch hẹn" screen, and is on only where `CROVE_MODULES` enables it (ADR-0031); the booking routes are registered only when `runtime.installed('crm')`. A member reads and changes only their own calendar; a booking event is cancelled only through its booking (`CALENDAR_EVENT_IS_BOOKING`), so the visitor is always told.

2. **Data** (every table a tenant table: `org_id`, `PRIMARY KEY (org_id, id)`, RLS through `apply_tenant_rls`):
   - `crove_kernel.availability_rule` (`20261030120000_crove_kernel_calendar.sql`): one row per weekly window (ISO weekday 1 to 7, `start_minute` and `end_minute` after local midnight, end exclusive) in the member's IANA zone. No row means the default, Monday to Friday 8:00 to 17:00 in `Asia/Ho_Chi_Minh`. A save replaces the whole set under a per-member advisory lock.
   - `crove_kernel.calendar_event` (same file): `starts_at` and `ends_at` as `timestamptz` (UTC instants) plus the `time_zone` they were set in; `kind` `manual`, `time_off` or `booking`; `status` `active` or `cancelled`, with `cancelled_at` and `cancelled_by`. An event lasts at most 31 days, so a range query looks back that far. Cancelled events stay, so a booking's history holds. Every active event is busy time; dates off are `time_off` events.
   - `crove_crm.event_type` (`20261030130000_crove_crm_event_types.sql`): slug unique per org, title, duration (5 to 480 minutes), buffers before and after, minimum notice (default 4 hours), horizon (default 60 days), daily limit, location (`in_person`, `phone`, `video` with a fixed value), `host_user_id`. Archived, never deleted (no `DELETE` grant).
   - `crove_crm.booking` (`20261031020000_crove_crm_bookings.sql`): `status` `pending`, `confirmed`, `refused` (with `refusal` `taken` or `unavailable`) or `cancelled`, the held `calendar_event_id`, `party_id`, the visitor's name, email, phone and note (nullable so an erasure can clear them), the visitor's zone, and the SHA-256 of the request token. Cancelled, never deleted. `20261031250000_crove_crm_booking_manage.sql` adds `revision` and the visitor's last ask from a manage link; `20261031260000_crove_crm_team_event_types.sql` adds `assignment` (`single`, `round_robin`, `collective`) and `co_host_user_ids` (1 to 9 beside the lead host) to the event type, and `hold_event_ids` to the booking.
   - The org purge deletes all four tables with a closing org's other working rows: `crove_kernel.org_purge` is redefined in `20261030120000_crove_kernel_calendar.sql`, `20261030130100_crove_kernel_org_purge_crm.sql` and `20261031020100_crove_kernel_org_purge_booking.sql`.

3. **No double booking, enforced by the database.** `calendar_event_no_double_booking` is `EXCLUDE USING gist` over a one-point `int8range` of `hashtextextended(org_id || ':' || user_id, 0)` and `tstzrange(starts_at, ends_at, '[)')`, both with `&&`, `WHERE (kind = 'booking' AND status = 'active')`. The member is hashed into a range because gist has no equality operator for `uuid` without the `btree_gist` extension, and Crove runs on any PostgreSQL 17 with no extension. Two members whose 64-bit hashes collide can only refuse each other's overlapping bookings (the insert fails on the constraint and the confirmation does not commit); a collision can never let a double booking through. Back-to-back bookings pass (`[)`).
   - Manual and time-off events are outside the constraint: a member may double-book their own meetings, and `kernel.calendar.event.add` takes no lock. The booking side reads them: `crm.booking.confirm` and the moves take a per-host advisory lock (`crove_crm.booking:<org>:<user>`, every host of a team in one order, so overlapping teams cannot deadlock), then check the slot against every active event of the host, whatever its kind. The constraint stays the last line against any other writer.
   - Tests: `apps/kernel/test/calendar.db.test.ts` checks the constraint directly (an overlapping active booking is refused; back to back, another member, a manual event and a cancelled booking pass). `apps/kernel/test/crm-bookings.db.test.ts` runs 200 confirmations of one slot at once: exactly 1 confirmed, 199 refused as `taken`, one active booking event.

4. **Slots are a pure function.** `packages/kernel-contract/src/calendar.ts`: `freeSlots()` works on UTC instants in milliseconds and converts to a zone's wall clock only at the edges (`zonedInstant()`, `zonedDate()`): the working windows of each local day in the host's zone, minus public holidays, minus busy time widened by the buffers, from the minimum notice to the horizon, not on a day whose limit is reached, stepped by the duration. A wall time a forward change skips maps to the instant after the gap, a repeated one to its first occurrence, so a zone that changes its offset inside the range stays correct. `teamSlots()` combines hosts: any host for round-robin, every host at the same start and end for collective. `packages/kernel-contract/test/calendar.test.ts` has fixed cases for daylight-saving zones and property tests over random cases from a seeded generator (repeatable), not fast-check as the plan suggested. A query reaches at most 120 days; a page read at most 31.

5. **Holidays are data in the contract.** The fixed-date holidays of the Labor Code (45/2019/QH14, Article 112) every year, plus a per-year table for the lunar ones (Tết, five days, and the Hùng Kings' commemoration), today 2026 to 2028. A year beyond the table has only the fixed dates. The government's yearly decisions (swapped working days, the day next to 2 September, compensatory days) are the org's own `time_off` events. Booking slots skip holidays.

6. **Booking through the worker.** The API's login cannot enter an org's system context, so the public page goes through definers granted to `crove_app`, as Social's review link does:
   - `crove_crm.booking_page()` returns the event type and, per host who may still host, the weekly hours and busy intervals as times only, never titles, other event types or who the hosts are; the API computes the free slots and sends only those.
   - `crove_crm.booking_request()` checks shape, notice and horizon, caps requests at 30 an hour per event type (under an advisory lock, so requests sent together still count), records a `pending` booking and emits `crm.booking.requested`. The visitor gets a 32-byte request token once; only its SHA-256 is stored, and `crove_crm.booking_status()` reads the outcome with it.
   - The worker runs `crm.booking.confirm` through `Runtime.execute()` as a system actor: under the host locks it re-checks the slot, holds the event (round-robin: the free host with the fewest upcoming bookings of the type, ties by member id; collective: an event on every host's calendar in one transaction, the others in `hold_event_ids`), matches the party by email (under its own lock) or creates one, writes an activity on the party's timeline, and queues the mails; or it marks the booking `refused`. Hosts who left the org or became viewers are skipped.

7. **The public route.** The SPA serves `/-/b/<org>/<type>`; the API serves `GET` and `POST /api/booking/:org/:type` (`apps/kernel/src/booking-page.ts`, wired in `apps/kernel/src/http.ts`), which is on the reasoned public list of the route-coverage invariant (`apps/kernel/test/invariant/route-coverage.test.ts`). `POST` takes a 4 KB body at most and either asks for a slot, follows a request, or reads, cancels or moves a booking with a manage token; tokens travel in the body, never the URL. Budgets per client address: 60 page reads, 5 requests and 90 polls a minute; 20 requests a minute per event type whatever the address. These limiters live in each API process's memory (`apps/kernel/src/rate-limit.ts`); the definer's hourly cap holds across instances.

8. **Turnstile is optional** (#1353, decision CAL-2): with `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` set, the page shows the widget and the kernel asks Cloudflare's siteverify before anything is recorded (`apps/kernel/src/turnstile.ts`); any doubt (no token, a refusal, an error, a timeout) refuses with 403. The CSP admits Turnstile's origin only then. Without keys, self-host runs with the rate limits alone.

9. **Manage links: a MAC, nothing stored.** A link carries `<booking id>.<revision>.<MAC>`, where the MAC is an HMAC-SHA256 of the id and revision under `crove_kernel.mail_hash_key` (which no runtime role can read), domain-separated (`crove.crm.booking.manage.v1`) and cut to 128 bits (`crove_crm.booking_manage_mac`). The mail template mints it at send time through `crm.booking.mail_data`, so the token never sits in the mail queue, and every mail of one revision carries a working link. It travels in the URL fragment (`#m=`), out of access logs. A token works while its revision is the booking's, the booking is confirmed and has not started. A cancel or a move, by the visitor (`crm.booking.manage`) or by the host in the app (`crm.booking.cancel`, `crm.booking.move`), raises the revision, which ends every earlier link: single use per action. A move stays with the same hosts.

10. **Mails and reminders** through the kernel mail pipeline (ADR-0034), template `crm.booking` (`apps/kernel/src/booking-mail.ts`): confirmed, moved and cancelled mails to the visitor and each host, with an `.ics` event (RFC 5545, one UID per booking, the revision as `SEQUENCE`, `METHOD:CANCEL` on a cancel), times in the recipient's zone. The merge data names the booking, not the visitor: the template reads the visitor's details at send time, so an erasure reaches queued mail too. `crm.booking.scheduled` makes the worker queue reminders 24 hours and 1 hour before; `crm.booking.remind` sends one only while the booking still starts then.

11. **External calendars (C6, #1374) and meeting links (C7, #1375): owner decision B of 2026-10-25.** Wait for Google and Microsoft OAuth apps and build two-way sync; no shortcut through a calendar's secret iCal address (option A, rejected). The owner action: a Google Cloud project with the Calendar API and a verified consent screen for the `calendar.events.owned` (write-back to the account's own calendar only, #2124) and `calendar.freebusy` scopes, a Microsoft Entra app registration with delegated `Calendars.ReadWrite`, client ids and secrets in the Cloud deployment's secrets, never the repo. What the build must use, from decisions already taken:
    - provider adapters with an FQDN allowlist and the OAuth connect flow of ADR-0025 (`oauth_state`, callback, a connect command through `execute()`); self-hosters register their own apps (ADR-0025, point 7);
    - tokens sealed in `crove_kernel.credential` by the `crove-local` broker, opened only in worker jobs, and refused once the connecting member leaves;
    - outbound calls through the egress guard (`egressFetch`, `packages/kernel-runtime/src/egress.ts`) and, for writes such as holding or removing a booking on the outside calendar or creating a meeting, through `crove_kernel.external_call`, so a timeout never doubles an effect;
    - `calendar_event.kind` widened with `google`, `microsoft` and `caldav` plus a `source_id` (Calendar plan §3.1), and only free/busy reaching slot computation, never outside titles;
    - free/busy drift against an external calendar of at most 1 minute (kernel plan, Phase 3 exit criteria);
    - meeting links created by the worker after the booking commits, stored on the booking, sent in the mails and the `.ics`, cancelled with it; a provider failure leaves the booking valid and tells the host (#1375).

    Open until C6 starts: how sync meets the 1-minute bound (provider push notifications or polling), whether outside events are stored as rows or as cached free/busy, whether CalDAV (no OAuth app) goes first, the redirect URIs, and the migration that widens `kind`. These are decided in C6's PR and recorded here as an amendment.

12. **The member booking feed (#1382, in progress)** goes the other way: a read-only, secret iCal address of a member's Crove bookings, served by the existing public `/cal/<token>.ics` route, for Google Calendar, Outlook or Apple Calendar to subscribe to. It sends Crove bookings out; it does not read outside calendars, so it is not the iCal-link option decision B rejected.

## Where the build differs from the plan

- The plan's §3.3 had the anonymous endpoint run the booking command itself. The API's login cannot enter a system context, so the page records a `pending` booking through a definer and the worker confirms it; the visitor's page polls for the outcome.
- Column and table names: `host_user_id` (plan: `host_member_id`), `availability_rule` (plan: `availability`).
- Property tests use a seeded generator, not fast-check.
- Team event types (C8) were built with v1; C6 and C7 wait for the owner's OAuth apps.

## Consequences

- HRM and Service can schedule against the same calendars without reading `crove_crm`; a module that writes another kind of event extends the `kind` CHECK in a kernel migration.
- `docker compose up` gives a working booking page with mails in Mailpit and no outside account; Turnstile and external calendars are optional.
- A booking needs the worker: with the worker down, requests stay `pending` and the page keeps polling.
- The holiday table must be extended every year before its last year runs out; until then a later year has only the fixed-date holidays.
- The in-memory rate limits hold per API instance; a multi-instance deployment puts a shared limit in front, and the per-type hourly cap in the database holds anyway.
- A hash collision between two members' keys gives a false "this time was just taken" for overlapping bookings, with a probability of about one in 2^64 per pair.
- Every new calendar table is a protected-path migration with its RLS matrix row and an org purge entry.

## Alternatives considered

- **The `btree_gist` extension**, for a plain `user_id WITH =` in the constraint. Rejected: Crove runs on any PostgreSQL 17 with no extension, and the hashed range gives the same guarantee, at the cost of rare false refusals.
- **Overlap checks in application code only.** Rejected: two transactions can both see a free slot. The advisory lock gives clean refusals; the constraint holds against any writer.
- **One constraint over every kind of event.** Rejected: people overlap their own meetings, and a manual event added while a booking is confirmed would fail for no good reason.
- **Embedding or running Cal.diy** (MIT, Cal.com's community edition). Rejected: its own auth, database and users break the one write path, RLS and the audit trail, and its README recommends it for personal, non-production use. It stays a reference for slot rules and flows; no code was copied.
- **Calendar tables inside `crove_crm`.** Rejected by §13: HRM and Service would read another module's tables or keep their own calendars.
- **Granting the API's login a system context** so the page books in one request. Rejected: it widens what the edge login can do in every org; the definers expose only the page's few narrow operations (read a page, request, follow a request, view or ask with a manage token).
- **Stored, random manage tokens.** Rejected: a secret at rest per booking, and every mail of one revision would need the same stored token; the MAC of id and revision stores nothing and ends with the revision.
- **The iCal-link shortcut for outside calendars** (option A on #1374). Rejected by the owner on 2026-10-25: read-only, no write-back, and a second path to retire once OAuth sync exists.

## Acceptance tests (in place)

- 200 concurrent confirmations of one slot give exactly 1 success (`apps/kernel/test/crm-bookings.db.test.ts`).
- An overlapping active booking of one member is refused by the database; a cancelled one frees the time (`apps/kernel/test/calendar.db.test.ts`).
- A manage link moves or cancels a booking once; a started booking takes no cancel or move; a reminder is sent only while the booking still starts then (`apps/kernel/test/crm-bookings.db.test.ts`).
- The page shows free slots only, nothing of the host's calendar (same file); slots stay correct across a daylight-saving change (`packages/kernel-contract/test/calendar.test.ts`).
- `/api/booking/:org/:type` is on the reasoned public list (`apps/kernel/test/invariant/route-coverage.test.ts`).
