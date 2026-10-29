-- Activity rows about one legal entity: the old rows get their entity, and the database now holds every such row to
-- one (issue #1805, the review of #1792). Idempotent; applied files stay untouched.
--
-- 20261104130000 made a new row of the record types finance.archive, finance.period and kernel.mail_message name its
-- entity (activity_entity_named, NOT VALID), and the commands that write tax obligation marks (kernel.tenant,
-- org.tax_obligation_done and org.tax_obligation_undone) and a party's entity links (kernel.party,
-- party.entity_linked and party.entity_unlinked) now name theirs too. Two gaps were left:
--   - Those four kinds are on record types that stay org-level, and the constraint does not cover them: a refactor
--     that dropped { legalEntityId } would write an org-level row and fail nothing.
--   - Rows written before #1792 are org-level: a member limited to entity A still read entity B's month locks,
--     archives, missing-invoice requests and reminders, and tax obligation and party link rows. And since a NOT VALID
--     CHECK also applies to an UPDATE, a later erasure that updated one of those old rows would fail with 23514.
--
-- The backfill, before the constraint is validated. Each org-level row of those record types or kinds takes, in order:
--   1. the entity its own command recorded: the ok audit event of the command that writes that kind (finance.period.lock
--      for period.locked, and so on below), of the same org, time and actor (one transaction writes both, at the same
--      now(); an agent is matched by agent_id), whose detail names a legalEntityId or legal_entity_id of the org, when
--      exactly one entity is named. Another command of the same transaction (a bulk approval) does not count;
--   2. for a missing-invoice mail, the legalEntityId its payload names (a request since #1280);
--   3. the org's default entity, else its first: a request made before #1280 was the default entity's; a year
--      archive, a reminder or a mark made before the commands named an entity recorded none. For an org with one
--      entity that is exact. For one with several, the row moves from every member to the members of the default
--      entity (owners and admins read every entity), which is narrower than before though not always the entity the
--      row was about; the record (the lock, the package, the mail) keeps the facts.
-- An UPDATE as the migration runner, the table's owner, which RLS does not filter; activity has no UPDATE trigger that
-- matters (as in 20261103120000). A rerun finds no row left to change. The table is locked against writes first, so a
-- row an older server writes during the deploy cannot slip in between the backfill and the validation.
--
-- activity_entity_named is then recreated with the four kinds beside the three record types, and validated: from
-- here on every row of them, old or new, names its entity, and an UPDATE of an old row passes.
-- apps/kernel/test/activity-record-types.test.ts keeps both lists equal to what the code names.
-- The constraint takes activity's ACCESS EXCLUSIVE lock and VALIDATE scans the table; lock_timeout bounds the wait,
-- and activity is not a hot table in the plan's list (§5.5).
SET LOCAL lock_timeout = '2s';

LOCK TABLE crove_kernel.activity IN SHARE ROW EXCLUSIVE MODE;

WITH command (kind, command) AS (
  VALUES ('period.locked', 'finance.period.lock'),
         ('period.unlocked', 'finance.period.unlock'),
         ('missing_invoices.requested', 'finance.missing_invoices.request'),
         ('org.tax_obligation_done', 'kernel.tax_obligation.done'),
         ('org.tax_obligation_undone', 'kernel.tax_obligation.undo'),
         ('party.entity_linked', 'kernel.party.link_entity'),
         ('party.entity_unlinked', 'kernel.party.unlink_entity')
), target AS (
  SELECT a.org_id, a.id, a.kind, a.record_type, a.record_id, a.occurred_at, a.actor_id, a.agent_id
  FROM crove_kernel.activity a
  WHERE a.legal_entity_id IS NULL
    AND (a.record_type IN ('finance.archive', 'finance.period', 'kernel.mail_message')
         OR a.kind IN ('org.tax_obligation_done', 'org.tax_obligation_undone', 'party.entity_linked', 'party.entity_unlinked'))
), from_audit AS (
  SELECT t.org_id, t.id, (pg_catalog.array_agg(DISTINCT e.id))[1] AS entity, pg_catalog.count(DISTINCT e.id) AS entities
  FROM target t
  JOIN command c ON c.kind = t.kind
  JOIN crove_kernel.audit_event ev
    ON ev.org_id = t.org_id AND ev.occurred_at = t.occurred_at AND ev.command = c.command AND ev.outcome = 'ok'
   AND CASE WHEN t.agent_id IS NOT NULL THEN ev.actor_type = 'agent' AND ev.actor_id = t.agent_id
            ELSE ev.actor_type <> 'agent' AND ev.actor_id IS NOT DISTINCT FROM t.actor_id END
  JOIN crove_kernel.legal_entity e
    ON e.org_id = t.org_id AND e.id::text = coalesce(ev.detail ->> 'legalEntityId', ev.detail ->> 'legal_entity_id')
  GROUP BY t.org_id, t.id
), from_mail AS (
  SELECT t.org_id, t.id, e.id AS entity
  FROM target t
  JOIN crove_kernel.mail_message m ON t.record_type = 'kernel.mail_message' AND m.org_id = t.org_id AND m.id = t.record_id
  JOIN crove_kernel.legal_entity e ON e.org_id = t.org_id AND e.id::text = m.payload ->> 'legalEntityId'
)
UPDATE crove_kernel.activity a
SET legal_entity_id = coalesce(
  fa.entity,
  fm.entity,
  -- Every org has a default entity (20261030001000, create_or_replay_org); the first entity only guards the rule.
  (SELECT e.id FROM crove_kernel.legal_entity e WHERE e.org_id = t.org_id ORDER BY e.is_default DESC, e.id LIMIT 1))
FROM target t
LEFT JOIN from_audit fa ON fa.org_id = t.org_id AND fa.id = t.id AND fa.entities = 1
LEFT JOIN from_mail fm ON fm.org_id = t.org_id AND fm.id = t.id
WHERE a.org_id = t.org_id AND a.id = t.id;

ALTER TABLE crove_kernel.activity DROP CONSTRAINT IF EXISTS activity_entity_named;
ALTER TABLE crove_kernel.activity ADD CONSTRAINT activity_entity_named
  CHECK ((record_type NOT IN ('finance.archive', 'finance.period', 'kernel.mail_message')
          AND kind NOT IN ('org.tax_obligation_done', 'org.tax_obligation_undone', 'party.entity_linked', 'party.entity_unlinked'))
         OR legal_entity_id IS NOT NULL) NOT VALID;
ALTER TABLE crove_kernel.activity VALIDATE CONSTRAINT activity_entity_named;
