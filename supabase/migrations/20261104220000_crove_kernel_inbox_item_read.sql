-- Inbox items are read by owners, admins and the system context only (issue #1780, left from #1720). Idempotent;
-- applied files stay untouched.
--
-- Before: the tenant policy let every member of the org read crove_kernel.inbox_item at the SQL level, viewers too;
-- only the query kernel.inbox.raised kept the items to owners and admins. No tenant code runs raw SQL, and an item
-- holds a queue name, a job id and a count, but the rule belongs in the database like the other rules of the table.
--
-- After: the RESTRICTIVE policy inbox_item_read lets a context read an item only as an owner or an admin of the org,
-- or as the system context (no user, no agent: the dead letter worker counting failures on an open item, the daily
-- prune, the org export). An UPDATE or DELETE that names a column reads the rows it changes, so a member or a viewer
-- now dismisses nothing either (kernel.inbox.dismiss is for owners and admins already). Agents read none.
DROP POLICY IF EXISTS inbox_item_read ON crove_kernel.inbox_item;
CREATE POLICY inbox_item_read ON crove_kernel.inbox_item AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL)
    OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = inbox_item.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
