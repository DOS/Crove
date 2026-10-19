-- Crove kernel (issue #333, item 2): an event records who emitted it. Idempotent; applied files stay untouched.
--
-- crove_kernel.emit() stored actor_id = ctx_user_id(), which is NULL in an agent context, so an event an agent's
-- command emitted looked like a system event. The outbox now records the actor the way audit rows do:
--   - actor_type: 'user', 'system' or 'agent', from the sealed context;
--   - actor_id: the user (unchanged meaning: a user id or NULL, so nothing reading it today changes);
--   - agent_id and agent_run: the agent and its run, for an agent context.
-- Events emitted before this migration keep actor_type NULL: the outbox is append-only for every role, so they are not
-- backfilled. emit() stays the only writer (tenant roles have no INSERT), and the new columns are stamped there, never
-- taken from the caller.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.outbox_event ADD COLUMN IF NOT EXISTS actor_type text;
ALTER TABLE crove_kernel.outbox_event ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE crove_kernel.outbox_event ADD COLUMN IF NOT EXISTS agent_run uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'outbox_event_actor' AND conrelid = 'crove_kernel.outbox_event'::regclass) THEN
    ALTER TABLE crove_kernel.outbox_event ADD CONSTRAINT outbox_event_actor CHECK (
      actor_type IS NULL
      OR (actor_type = 'user' AND actor_id IS NOT NULL AND agent_id IS NULL AND agent_run IS NULL)
      OR (actor_type = 'agent' AND actor_id IS NULL AND agent_id IS NOT NULL AND agent_run IS NOT NULL)
      OR (actor_type = 'system' AND actor_id IS NULL AND agent_id IS NULL AND agent_run IS NULL)
    );
  END IF;
END $$;

-- Same body as 20261013120000 but for the actor columns, read from the sealed context (ctx_verified, which checks the
-- seal). A context without an actor key counts as a user when it names one, else as the system.
CREATE OR REPLACE FUNCTION crove_kernel.emit(p_type text, p_payload jsonb, p_command_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_actor text;
  v_id uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  v_actor := COALESCE(v_ctx ->> 'actor', CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END);
  INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_id, command_id, actor_type, agent_id, agent_run)
  VALUES (
    v_org, p_type, p_payload,
    CASE WHEN v_actor = 'user' THEN v_user END,
    p_command_id,
    v_actor,
    CASE WHEN v_actor = 'agent' THEN (v_ctx ->> 'agent')::uuid END,
    CASE WHEN v_actor = 'agent' THEN (v_ctx ->> 'run')::uuid END
  )
  RETURNING id INTO v_id;
  INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_org, v_id);
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN v_id;
END $$;
