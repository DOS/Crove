-- The publish queue of LinkedIn Company Page posts (#1077), as for every other channel.
SELECT crove_jobs.create_queue('social-publish-linkedin_page', '{"policy":"stately","expireInSeconds":300}'::jsonb);
