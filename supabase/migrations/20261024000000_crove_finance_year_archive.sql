-- Fiscal year archive packages (issue #922, plan §7.9). Idempotent; applied files stay untouched.
--
-- The package has no table of its own: finance.archive.build and finance.archive.record keep their state in their
-- audit rows (as the org export does), and the package's parts are content-addressed blobs under
-- archive/<org_id>/<year>/ in the blob store. This migration only creates the worker's queue (QUEUES.yearArchive in
-- apps/kernel/src/jobs-schema.ts); create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('finance-year-archive', '{"policy":"standard"}'::jsonb);
