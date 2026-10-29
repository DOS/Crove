-- Inbox items are read by owners, admins and the system context only (issue #1780, left from #1720). Idempotent;
-- applied files stay untouched.
--
-- Before: the tenant policy let every member of the org read crove_kernel.inbox_item at the SQL level, viewers too;
-- only the query kernel.inbox.raised kept the items to owners and admins. No tenant code runs raw SQL, and an item
-- holds a queue name, a job id and a count, but the rule belongs in the database like the other rules of the table.
--
-- After: the RESTRICTIVE policy inbox_item_read lets a context read an item only as an owner or an admin of the org,
-- or as the system context (no user, no agent: the dead letter worker counting failures on an open item, the daily
-- prune, the org export). Agents read none. The RESTRICTIVE policy inbox_item_change holds updates to the same
-- contexts: PostgreSQL applies a SELECT policy to an UPDATE only when the statement reads a column, so without it a
-- member could still dismiss every open item with an UPDATE that has no WHERE (kernel.inbox.dismiss is for owners and
-- admins already). Deletes stay the system context's (inbox_item_prune).
DROP POLICY IF EXISTS inbox_item_read ON crove_kernel.inbox_item;
CREATE POLICY inbox_item_read ON crove_kernel.inbox_item AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL)
    OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = inbox_item.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS inbox_item_change ON crove_kernel.inbox_item;
CREATE POLICY inbox_item_change ON crove_kernel.inbox_item AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL)
    OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = inbox_item.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
