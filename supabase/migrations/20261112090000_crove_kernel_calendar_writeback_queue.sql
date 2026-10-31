-- SPDX-License-Identifier: AGPL-3.0-only
-- The queue of the event-fed write-back of bookings to a member's connected calendar (#2124, part of #1374, C6b part 2).
-- Idempotent; applied files stay untouched.
--
-- Added here:
--   kernel-calendar-writeback  one job per booking event the outbox relay hands over (a booking confirmed, moved or
--                       cancelled): the worker makes the provider's events match the bookings of every write-back
--                       connection of the org at once, instead of at the next 15 minute sweep. The sweep stays as the
--                       backstop (a lost job, a token about to run out). Its jobs name the org only.
SET LOCAL lock_timeout = '2s';

SELECT crove_jobs.create_queue('kernel-calendar-writeback', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
