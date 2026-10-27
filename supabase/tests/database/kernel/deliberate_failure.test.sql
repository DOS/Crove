-- TEMPORARY (#1627 acceptance 1): a deliberately failing assertion, to show that it turns the db job red. Reverted in
-- the next commit.
SELECT plan(1);
SELECT ok(false, 'deliberately failing assertion');
SELECT * FROM finish();
