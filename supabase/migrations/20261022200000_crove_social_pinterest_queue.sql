-- The publish queue of Pinterest pins (#798), as for every other channel.
SELECT crove_jobs.create_queue('social-publish-pinterest', '{"policy":"stately","expireInSeconds":300}'::jsonb);
