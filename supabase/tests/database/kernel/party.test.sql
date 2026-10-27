-- The party slice of the kernel (plan §10 "Golden module", issue #1627): what the database itself holds for
-- crove_kernel.party, whichever command writes it. Runs as the superuser, so row-level security does not apply here
-- (_rls_matrix.test.sql covers it), in a transaction the runner rolls back (packages/db/test/pgtap.db.test.ts).
SELECT plan(15);

-- Two orgs, each with its owner, made by the definers the API runs.
SELECT set_config('test.user_a', crove_kernel.identity_upsert('pgtap', 'party-a', 'party-a@example.com', 'Party A owner')::text, true);
SELECT set_config('test.user_b', crove_kernel.identity_upsert('pgtap', 'party-b', 'party-b@example.com', 'Party B owner')::text, true);
SELECT set_config('test.org_a', crove_kernel.create_or_replay_org(current_setting('test.user_a')::uuid, 'pgtap-party-a', 'pgTAP party A', NULL)::text, true);
SELECT set_config('test.org_b', crove_kernel.create_or_replay_org(current_setting('test.user_b')::uuid, 'pgtap-party-b', 'pgTAP party B', NULL)::text, true);

-- The table: a tenant table under the tenant policy, nothing for PUBLIC.
SELECT has_table('crove_kernel', 'party', 'crove_kernel.party exists');
SELECT col_is_pk('crove_kernel', 'party', ARRAY['org_id', 'id']::name[], 'its primary key is (org_id, id)');
SELECT ok((SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = 'crove_kernel.party'::regclass),
  'row-level security is on');
SELECT ok(EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies p
    WHERE p.schemaname = 'crove_kernel' AND p.tablename = 'party' AND p.policyname = 'tenant_isolation'
      AND p.permissive = 'PERMISSIVE' AND p.cmd = 'ALL' AND p.roles = ARRAY['crove_tenant']::name[]),
  'the tenant_isolation policy covers every command for crove_tenant');
SELECT ok(NOT pg_catalog.has_table_privilege('public', 'crove_kernel.party', 'SELECT, INSERT, UPDATE, DELETE'),
  'PUBLIC holds no privilege on it');

-- A tax code names one party per org.
SELECT lives_ok($$
  INSERT INTO crove_kernel.party (org_id, id, name, tax_code)
  VALUES (current_setting('test.org_a')::uuid, '00000000-0000-7000-8000-000000000001', 'Alpha Trading', '0101234567')$$,
  'a party with a tax code');
SELECT throws_ok($$
  INSERT INTO crove_kernel.party (org_id, id, name, tax_code)
  VALUES (current_setting('test.org_a')::uuid, '00000000-0000-7000-8000-000000000002', 'Alpha again', '0101234567')$$,
  '23505', NULL, 'a second party of the org with the same tax code is refused');
SELECT lives_ok($$
  INSERT INTO crove_kernel.party (org_id, id, name, tax_code)
  VALUES (current_setting('test.org_b')::uuid, '00000000-0000-7000-8000-000000000008', 'Alpha in org B', '0101234567')$$,
  'another org may hold a party with the same tax code');

-- A party is an organization or a person.
SELECT throws_ok($$
  INSERT INTO crove_kernel.party (org_id, id, kind, name)
  VALUES (current_setting('test.org_a')::uuid, '00000000-0000-7000-8000-000000000003', 'robot', 'Robot')$$,
  '23514', NULL, 'a kind other than organization or person is refused');

-- Duplicates (#887): one level only, inside one org.
SELECT lives_ok($$
  INSERT INTO crove_kernel.party (org_id, id, name)
  SELECT current_setting('test.org_a')::uuid, v.id::uuid, v.name
  FROM (VALUES ('00000000-0000-7000-8000-000000000004', 'Kept'), ('00000000-0000-7000-8000-000000000005', 'Duplicate'),
               ('00000000-0000-7000-8000-000000000006', 'Other'), ('00000000-0000-7000-8000-000000000007', 'Fourth')) v (id, name)$$,
  'four parties to mark');
SELECT throws_ok($$
  UPDATE crove_kernel.party SET duplicate_of = id
  WHERE org_id = current_setting('test.org_a')::uuid AND id = '00000000-0000-7000-8000-000000000004'$$,
  '23514', NULL, 'a party is never a duplicate of itself');
SELECT lives_ok($$
  UPDATE crove_kernel.party SET duplicate_of = '00000000-0000-7000-8000-000000000004'
  WHERE org_id = current_setting('test.org_a')::uuid AND id = '00000000-0000-7000-8000-000000000005'$$,
  'a party is marked as a duplicate of the kept one');
SELECT throws_ok($$
  UPDATE crove_kernel.party SET duplicate_of = '00000000-0000-7000-8000-000000000005'
  WHERE org_id = current_setting('test.org_a')::uuid AND id = '00000000-0000-7000-8000-000000000006'$$,
  '23514', 'PARTY_DUPLICATE_CHAIN: the kept party is itself a duplicate', 'a duplicate is never kept for another party');
SELECT throws_ok($$
  UPDATE crove_kernel.party SET duplicate_of = '00000000-0000-7000-8000-000000000007'
  WHERE org_id = current_setting('test.org_a')::uuid AND id = '00000000-0000-7000-8000-000000000004'$$,
  '23514', 'PARTY_DUPLICATE_CHAIN: other parties are duplicates of this one', 'a party others point at never becomes a duplicate');
SELECT throws_ok($$
  UPDATE crove_kernel.party SET duplicate_of = '00000000-0000-7000-8000-000000000008'
  WHERE org_id = current_setting('test.org_a')::uuid AND id = '00000000-0000-7000-8000-000000000006'$$,
  '23503', NULL, 'a party is never a duplicate of a party of another org');

SELECT * FROM finish();
