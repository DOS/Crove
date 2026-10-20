-- Crove Social: in-app notifications (issue #637). Idempotent.
--
-- notification       something that happened to a post, or to a channel, for one member. The worker writes it
--                    (social.notification.dispatch, from an outbox event), once per event and person, never for the
--                    person who acted. A restrictive policy on top of the tenant one shows each member only their own;
--                    the system context, which writes them, sees the org's, and an agent context sees none. Members
--                    change only read_at. Read ones go after 30 days, any after 90 (the dispatch prunes them).
-- notification_mute  a kind of notification a member turned off; the dispatch skips that member for that kind.
--
-- A client's answer on a review link (#589) is recorded by a definer that runs without a tenant context, so it cannot
-- call emit(). It now writes its event, social.review.answered (ids only), the way emit() writes a system event: the
-- outbox row with actor_type 'system', its pending row, and the notify.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.notification (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('review_requested', 'decided', 'failed', 'needs_attention', 'channel_expired', 'comment', 'client_answer', 'assigned')),
  -- The outbox event it comes from.
  event_id uuid NOT NULL,
  post_id uuid,
  connection_id uuid,
  -- The member who acted, when one did.
  actor_user_id uuid,
  -- What the item shows besides the post: a decision, a client's verdict and name, a channel's provider.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT notification_once UNIQUE (org_id, event_id, user_id),
  CONSTRAINT notification_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS notification_user_idx ON crove_social.notification (org_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_unread_idx ON crove_social.notification (org_id, user_id) WHERE read_at IS NULL;
SELECT crove_kernel.apply_tenant_rls('crove_social.notification');
REVOKE UPDATE ON crove_social.notification FROM crove_tenant;
GRANT UPDATE (read_at) ON crove_social.notification TO crove_tenant;
DROP POLICY IF EXISTS own_notification ON crove_social.notification;
-- Each context function is wrapped in a subquery, as the tenant policy is, so it runs once per statement.
CREATE POLICY own_notification ON crove_social.notification AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL))
  WITH CHECK (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL));
-- An open app re-reads its own notifications when one arrives or is read elsewhere (ids only, as every hint).
DROP TRIGGER IF EXISTS stream_hint ON crove_social.notification;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_social.notification
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('social_notification', 'id');

CREATE TABLE IF NOT EXISTS crove_social.notification_mute (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('review_requested', 'decided', 'failed', 'needs_attention', 'channel_expired', 'comment', 'client_answer', 'assigned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, kind)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.notification_mute');
REVOKE UPDATE ON crove_social.notification_mute FROM crove_tenant;
DROP POLICY IF EXISTS own_notification_mute ON crove_social.notification_mute;
CREATE POLICY own_notification_mute ON crove_social.notification_mute AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL))
  WITH CHECK (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL));

-- The worker's queue for the dispatch: one job per event (singleton key <org>:<event>). create_queue skips a queue
-- that exists.
SELECT crove_jobs.create_queue('social-notify', '{"policy":"standard"}'::jsonb);

-- Same body as 20261021020000 but for the event.
CREATE OR REPLACE FUNCTION crove_social.review_feedback_add(p_token text, p_name text, p_verdict text, p_body text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.review_link;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_body text := nullif(pg_catalog.btrim(coalesce(p_body, '')), '');
  v_id uuid;
  v_event uuid;
BEGIN
  IF pg_catalog.length(v_name) NOT BETWEEN 1 AND 100 OR p_verdict IS NULL OR p_verdict NOT IN ('approved', 'changes_requested', 'comment')
     OR (v_body IS NOT NULL AND pg_catalog.length(v_body) > 2000) OR (p_verdict = 'comment' AND v_body IS NULL) THEN
    RAISE EXCEPTION 'invalid review feedback' USING ERRCODE = '22023';
  END IF;
  -- Locked, so the cap below holds against answers sent at the same time.
  v_link := crove_social.review_link_by_token(p_token, true);
  IF v_link.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM crove_social.review_feedback f WHERE f.org_id = v_link.org_id AND f.link_id = v_link.id) >= 100 THEN
    RAISE EXCEPTION 'review link answer limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_social.review_feedback (org_id, link_id, post_id, reviewer_name, verdict, body, changed)
  VALUES (v_link.org_id, v_link.id, v_link.post_id, v_name, p_verdict, v_body,
          crove_social.review_content_key(v_link.org_id, v_link.post_id) <> v_link.content_key)
  RETURNING id INTO v_id;
  INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
  VALUES (v_link.org_id, 'social.review.answered', pg_catalog.jsonb_build_object('post_id', v_link.post_id, 'feedback_id', v_id), 'system')
  RETURNING id INTO v_event;
  INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_link.org_id, v_event);
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN pg_catalog.jsonb_build_object('recorded', true);
END $$;
REVOKE ALL ON FUNCTION crove_social.review_feedback_add(text, text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_feedback_add(text, text, text, text) TO crove_app;
