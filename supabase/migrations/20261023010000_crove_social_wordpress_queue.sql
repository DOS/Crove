-- The publish queue of WordPress posts (#833), as for every other channel.
SELECT crove_jobs.create_queue('social-publish-wordpress', '{"policy":"stately","expireInSeconds":300}'::jsonb);
