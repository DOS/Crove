-- The publish queue of Google Business Profile (issue #709), as every channel provider has its own
-- (20261019040000). create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('social-publish-google_business', '{"policy":"stately","expireInSeconds":300}'::jsonb);
