-- RLS matrix smoke (plan §10 G3, issue #1627): one tenant table, crove_kernel.party, probed as the API login role
-- crove_app, without a context and in the sealed context of org A, against a party of org B. The generated matrix over
-- every table and every runtime role is apps/kernel/test/invariant/rls-matrix.db.test.ts (T8); this file shows the
-- same isolation in pgTAP. A gate file: `_*.test.sql` is a protected path.
--
-- plan() runs as the superuser before SET ROLE: pgTAP keeps its state in temporary tables, which Crove roles may not
-- create (T17). The runner rolls the transaction back.
SELECT plan(8);

-- Two orgs, each with its owner and one party (written as the superuser, which bypasses row-level security).
SELECT set_config('test.user_a', crove_kernel.identity_upsert('pgtap', 'rls-a', 'rls-a@example.com', 'RLS A owner')::text, true);
SELECT set_config('test.user_b', crove_kernel.identity_upsert('pgtap', 'rls-b', 'rls-b@example.com', 'RLS B owner')::text, true);
SELECT set_config('test.org_a', crove_kernel.create_or_replay_org(current_setting('test.user_a')::uuid, 'pgtap-rls-a', 'pgTAP RLS A', NULL)::text, true);
SELECT set_config('test.org_b', crove_kernel.create_or_replay_org(current_setting('test.user_b')::uuid, 'pgtap-rls-b', 'pgTAP RLS B', NULL)::text, true);
INSERT INTO crove_kernel.party (org_id, id, name) VALUES
  (current_setting('test.org_a')::uuid, '00000000-0000-7000-8000-00000000000a', 'Party of A'),
  (current_setting('test.org_b')::uuid, '00000000-0000-7000-8000-00000000000b', 'Party of B');

SET LOCAL ROLE crove_app;

-- The refused inserts name the message, not only 42501, so a lost INSERT grant ("permission denied", also 42501)
-- cannot pass for row-level security. PostgreSQL names a policy in that message only when a RESTRICTIVE one fails;
-- tenant_isolation is PERMISSIVE, so the message names the table alone.

-- No context: nothing is visible and nothing can be written.
SELECT is((SELECT pg_catalog.count(*) FROM crove_kernel.party), 0::bigint, 'without a context crove_app sees no party');
SELECT throws_ok($$
  INSERT INTO crove_kernel.party (org_id, id, name)
  VALUES (current_setting('test.org_a')::uuid, '00000000-0000-7000-8000-0000000000a1', 'No context')$$,
  '42501', 'new row violates row-level security policy for table "party"', 'without a context crove_app inserts no party');

-- Org A's context: its own party only.
SELECT is(crove_kernel.enter_context(current_setting('test.user_a')::uuid, current_setting('test.org_a')::uuid), 'owner',
  'the owner of org A enters its context');
SELECT is((SELECT pg_catalog.count(*) FROM crove_kernel.party WHERE org_id = current_setting('test.org_a')::uuid), 1::bigint,
  'org A sees its own party');
-- TEMPORARY PROOF (#1643): this assertion is dropped in the PR's copy only.
SELECT throws_ok($$
  INSERT INTO crove_kernel.party (org_id, id, name)
  VALUES (current_setting('test.org_b')::uuid, '00000000-0000-7000-8000-0000000000a2', 'Planted by A')$$,
  '42501', 'new row violates row-level security policy for table "party"', 'org A inserts no party into org B');
SELECT lives_ok($$UPDATE crove_kernel.party SET name = 'Renamed by A' WHERE org_id = current_setting('test.org_b')::uuid$$,
  'an update aimed at org B runs');
SELECT lives_ok($$DELETE FROM crove_kernel.party WHERE org_id = current_setting('test.org_b')::uuid$$,
  'a delete aimed at org B runs');

RESET ROLE;

-- ... and touched no row of org B.
SELECT is((SELECT pg_catalog.string_agg(name, ', ') FROM crove_kernel.party WHERE org_id = current_setting('test.org_b')::uuid),
  'Party of B', 'org B keeps its party, unchanged');

SELECT * FROM finish();
