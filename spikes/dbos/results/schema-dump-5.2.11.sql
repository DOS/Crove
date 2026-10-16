SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
CREATE SCHEMA crove_dbos;
CREATE FUNCTION crove_dbos.enqueue_workflow(workflow_name text, queue_name text, positional_args json[] DEFAULT ARRAY[]::json[], named_args json DEFAULT '{}'::json, class_name text DEFAULT NULL::text, config_name text DEFAULT NULL::text, workflow_id text DEFAULT NULL::text, app_version text DEFAULT NULL::text, timeout_ms bigint DEFAULT NULL::bigint, deadline_epoch_ms bigint DEFAULT NULL::bigint, deduplication_id text DEFAULT NULL::text, priority integer DEFAULT NULL::integer, queue_partition_key text DEFAULT NULL::text, authenticated_user text DEFAULT NULL::text, authenticated_roles text DEFAULT NULL::text, delay_until_epoch_ms bigint DEFAULT NULL::bigint, application_name text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
    v_workflow_id TEXT;
    v_serialized_inputs TEXT;
    v_owner_xid TEXT;
    v_now BIGINT;
    v_recovery_attempts INT4 := 0;
    v_priority INT4;
    v_status TEXT;
BEGIN
    -- Validate required parameters
    IF workflow_name IS NULL OR workflow_name = '' THEN
        RAISE EXCEPTION 'Workflow name cannot be null or empty';
    END IF;
    IF queue_name IS NULL OR queue_name = '' THEN
        RAISE EXCEPTION 'Queue name cannot be null or empty';
    END IF;
    IF named_args IS NOT NULL AND jsonb_typeof(named_args::jsonb) != 'object' THEN
        RAISE EXCEPTION 'Named args must be a JSON object';
    END IF;
    IF workflow_id IS NOT NULL AND workflow_id = '' THEN
        RAISE EXCEPTION 'Workflow ID cannot be an empty string if provided.';
    END IF;
    IF delay_until_epoch_ms IS NOT NULL AND delay_until_epoch_ms < 0 THEN
        RAISE EXCEPTION 'delay_until_epoch_ms must be >= 0';
    END IF;
    v_workflow_id := COALESCE(workflow_id, gen_random_uuid()::TEXT);
    v_owner_xid := gen_random_uuid()::TEXT;
    v_priority := COALESCE(priority, 0);
    v_serialized_inputs := json_build_object(
        'positionalArgs', positional_args,
        'namedArgs', named_args
    )::TEXT;
    v_now := EXTRACT(epoch FROM now()) * 1000;
    v_status := CASE WHEN delay_until_epoch_ms IS NULL THEN 'ENQUEUED' ELSE 'DELAYED' END;
    INSERT INTO "crove_dbos".workflow_status (
        workflow_uuid, status,
        name, class_name, config_name,
        queue_name, deduplication_id, priority, queue_partition_key,
        application_version,
        created_at, updated_at, recovery_attempts,
        workflow_timeout_ms, workflow_deadline_epoch_ms,
        parent_workflow_id, owner_xid, serialization,
        authenticated_user, authenticated_roles,
        delay_until_epoch_ms, application_name
    ) VALUES (
        v_workflow_id, v_status,
        workflow_name, class_name, config_name,
        queue_name, deduplication_id, v_priority, queue_partition_key,
        app_version,
        v_now, v_now, v_recovery_attempts,
        timeout_ms, deadline_epoch_ms,
        NULL, v_owner_xid, 'portable_json',
        authenticated_user, authenticated_roles,
        delay_until_epoch_ms, application_name
    )
    ON CONFLICT (workflow_uuid)
    DO UPDATE SET
        updated_at = EXCLUDED.updated_at;
    INSERT INTO "crove_dbos".workflow_input (
        workflow_uuid, inputs, retention_timestamp
    ) VALUES (
        v_workflow_id, v_serialized_inputs, v_now
    )
    ON CONFLICT (workflow_uuid) DO NOTHING;
    RETURN v_workflow_id;
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'DBOS queue duplicated'
            USING DETAIL = format('Workflow %s with queue %s and deduplication ID %s already exists', v_workflow_id, queue_name, deduplication_id),
                ERRCODE = 'unique_violation';
END;
$$;
CREATE FUNCTION crove_dbos.notifications_function() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
    DECLARE
        payload text := NEW.destination_uuid || '::' || NEW.topic;
    BEGIN
        PERFORM pg_notify('dbos_notifications_channel', payload);
        RETURN NEW;
    END;
    $$;
CREATE FUNCTION crove_dbos.send_message(destination_id text, message json, topic text DEFAULT NULL::text, message_id text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
        DECLARE
            v_topic TEXT := COALESCE(topic, '__null__topic__');
            v_message_id TEXT := COALESCE(message_id, gen_random_uuid()::TEXT);
        BEGIN
            INSERT INTO "crove_dbos".notifications (
                destination_uuid, topic, message, message_uuid, serialization
            ) VALUES (
                destination_id, v_topic, message, v_message_id, 'portable_json'
            )
            ON CONFLICT (message_uuid) DO NOTHING;
        EXCEPTION
            WHEN foreign_key_violation THEN
                RAISE EXCEPTION 'DBOS non-existent workflow'
                   USING DETAIL = format('Destination workflow %s does not exist', destination_id),
                        ERRCODE = 'foreign_key_violation';
        END;
        $$;
SET default_tablespace = '';
SET default_table_access_method = heap;
CREATE TABLE crove_dbos.application_versions (
    version_id text NOT NULL,
    version_name text NOT NULL,
    version_timestamp bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL,
    created_at bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL,
    application_name text
);
CREATE TABLE crove_dbos.dbos_migrations (
    version bigint NOT NULL
);
CREATE TABLE crove_dbos.event_dispatch_kv (
    service_name text NOT NULL,
    workflow_fn_name text NOT NULL,
    key text NOT NULL,
    value text,
    update_seq numeric(38,0),
    update_time numeric(38,15)
);
CREATE TABLE crove_dbos.notifications (
    message_uuid text DEFAULT gen_random_uuid() NOT NULL,
    destination_uuid text NOT NULL,
    topic text,
    message text NOT NULL,
    created_at_epoch_ms bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL,
    serialization text,
    consumed boolean DEFAULT false NOT NULL,
    consumed_by_function_id integer
);
CREATE TABLE crove_dbos.operation_outputs (
    workflow_uuid text NOT NULL,
    function_id integer NOT NULL,
    function_name text DEFAULT ''::text NOT NULL,
    output text,
    error text,
    child_workflow_id text,
    started_at_epoch_ms bigint,
    completed_at_epoch_ms bigint,
    serialization text,
    application_name text,
    retention_timestamp bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL
);
CREATE TABLE crove_dbos.queues (
    queue_id text DEFAULT (gen_random_uuid())::text NOT NULL,
    name text NOT NULL,
    concurrency integer,
    worker_concurrency integer,
    rate_limit_max integer,
    rate_limit_period_sec double precision,
    priority_enabled boolean DEFAULT false NOT NULL,
    partition_queue boolean DEFAULT false NOT NULL,
    polling_interval_sec double precision DEFAULT 1.0 NOT NULL,
    created_at bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL,
    updated_at bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL,
    application_name text,
    partition_concurrency integer,
    partition_worker_concurrency integer,
    partition_rate_limit_max integer,
    partition_rate_limit_period_sec double precision
);
CREATE TABLE crove_dbos.streams (
    workflow_uuid text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    "offset" integer NOT NULL,
    function_id integer DEFAULT 0 NOT NULL,
    serialization text
);
CREATE TABLE crove_dbos.workflow_events (
    workflow_uuid text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    serialization text
);
CREATE TABLE crove_dbos.workflow_events_history (
    workflow_uuid text NOT NULL,
    function_id integer NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    serialization text
);
CREATE TABLE crove_dbos.workflow_input (
    workflow_uuid text NOT NULL,
    inputs text,
    retention_timestamp bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL
);
CREATE TABLE crove_dbos.workflow_output (
    workflow_uuid text NOT NULL,
    output text,
    error text,
    retention_timestamp bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL
);
CREATE TABLE crove_dbos.workflow_schedules (
    schedule_id text NOT NULL,
    schedule_name text NOT NULL,
    workflow_name text NOT NULL,
    workflow_class_name text,
    schedule text NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    context text NOT NULL,
    last_fired_at text,
    automatic_backfill boolean DEFAULT false NOT NULL,
    cron_timezone text,
    queue_name text,
    application_name text
);
CREATE TABLE crove_dbos.workflow_status (
    workflow_uuid text NOT NULL,
    status text,
    name text,
    authenticated_user text,
    assumed_role text,
    authenticated_roles text,
    request text,
    output text,
    error text,
    executor_id text,
    created_at bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL,
    updated_at bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL,
    application_version text,
    application_id text,
    class_name character varying(255) DEFAULT NULL::character varying,
    config_name character varying(255) DEFAULT NULL::character varying,
    recovery_attempts bigint DEFAULT 0,
    queue_name text,
    workflow_timeout_ms bigint,
    workflow_deadline_epoch_ms bigint,
    inputs text,
    started_at_epoch_ms bigint,
    deduplication_id text,
    priority integer DEFAULT 0 NOT NULL,
    queue_partition_key text,
    forked_from text,
    owner_xid text,
    parent_workflow_id text,
    serialization text,
    delay_until_epoch_ms bigint,
    was_forked_from boolean DEFAULT false NOT NULL,
    rate_limited boolean DEFAULT false NOT NULL,
    completed_at bigint,
    attributes jsonb,
    schedule_name text,
    debounce_deadline_epoch_ms bigint,
    is_debounced boolean DEFAULT false NOT NULL,
    application_name text,
    creator_xid text
);
ALTER TABLE ONLY crove_dbos.application_versions
    ADD CONSTRAINT application_versions_pkey PRIMARY KEY (version_id);
ALTER TABLE ONLY crove_dbos.application_versions
    ADD CONSTRAINT application_versions_version_name_key UNIQUE (version_name);
ALTER TABLE ONLY crove_dbos.dbos_migrations
    ADD CONSTRAINT dbos_migrations_pkey PRIMARY KEY (version);
ALTER TABLE ONLY crove_dbos.event_dispatch_kv
    ADD CONSTRAINT event_dispatch_kv_pkey PRIMARY KEY (service_name, workflow_fn_name, key);
ALTER TABLE ONLY crove_dbos.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (message_uuid);
ALTER TABLE ONLY crove_dbos.operation_outputs
    ADD CONSTRAINT operation_outputs_pkey PRIMARY KEY (workflow_uuid, function_id);
ALTER TABLE ONLY crove_dbos.queues
    ADD CONSTRAINT queues_name_key UNIQUE (name);
ALTER TABLE ONLY crove_dbos.queues
    ADD CONSTRAINT queues_pkey PRIMARY KEY (queue_id);
ALTER TABLE ONLY crove_dbos.streams
    ADD CONSTRAINT streams_pkey PRIMARY KEY (workflow_uuid, key, "offset");
ALTER TABLE ONLY crove_dbos.workflow_events_history
    ADD CONSTRAINT workflow_events_history_pkey PRIMARY KEY (workflow_uuid, function_id, key);
ALTER TABLE ONLY crove_dbos.workflow_events
    ADD CONSTRAINT workflow_events_pkey PRIMARY KEY (workflow_uuid, key);
ALTER TABLE ONLY crove_dbos.workflow_input
    ADD CONSTRAINT workflow_input_pkey PRIMARY KEY (workflow_uuid);
ALTER TABLE ONLY crove_dbos.workflow_output
    ADD CONSTRAINT workflow_output_pkey PRIMARY KEY (workflow_uuid);
ALTER TABLE ONLY crove_dbos.workflow_schedules
    ADD CONSTRAINT workflow_schedules_pkey PRIMARY KEY (schedule_id);
ALTER TABLE ONLY crove_dbos.workflow_schedules
    ADD CONSTRAINT workflow_schedules_schedule_name_key UNIQUE (schedule_name);
ALTER TABLE ONLY crove_dbos.workflow_status
    ADD CONSTRAINT workflow_status_pkey PRIMARY KEY (workflow_uuid);
CREATE INDEX idx_operation_outputs_completed_at_function_name_v2 ON crove_dbos.operation_outputs USING btree (completed_at_epoch_ms, function_name) INCLUDE (application_name);
CREATE INDEX idx_operation_outputs_retention ON crove_dbos.operation_outputs USING btree (retention_timestamp);
CREATE INDEX idx_workflow_input_retention ON crove_dbos.workflow_input USING btree (retention_timestamp);
CREATE INDEX idx_workflow_output_retention ON crove_dbos.workflow_output USING btree (retention_timestamp);
CREATE INDEX idx_workflow_status_attributes ON crove_dbos.workflow_status USING gin (attributes) WHERE (attributes IS NOT NULL);
CREATE INDEX idx_workflow_status_completed_at ON crove_dbos.workflow_status USING btree (completed_at) WHERE (completed_at IS NOT NULL);
CREATE INDEX idx_workflow_status_deadline ON crove_dbos.workflow_status USING btree (workflow_deadline_epoch_ms) WHERE ((status = ANY (ARRAY['ENQUEUED'::text, 'PENDING'::text, 'DELAYED'::text])) AND (workflow_deadline_epoch_ms IS NOT NULL));
CREATE INDEX idx_workflow_status_delayed ON crove_dbos.workflow_status USING btree (delay_until_epoch_ms) WHERE (status = 'DELAYED'::text);
CREATE INDEX idx_workflow_status_failed ON crove_dbos.workflow_status USING btree (status, created_at) WHERE (status = ANY (ARRAY['ERROR'::text, 'CANCELLED'::text, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'::text]));
CREATE INDEX idx_workflow_status_forked_from ON crove_dbos.workflow_status USING btree (forked_from) WHERE (forked_from IS NOT NULL);
CREATE INDEX idx_workflow_status_in_flight_v2 ON crove_dbos.workflow_status USING btree (queue_name, status, priority, created_at) INCLUDE (application_name) WHERE (status = ANY (ARRAY['ENQUEUED'::text, 'PENDING'::text]));
CREATE INDEX idx_workflow_status_parent_workflow_id ON crove_dbos.workflow_status USING btree (parent_workflow_id) WHERE (parent_workflow_id IS NOT NULL);
CREATE INDEX idx_workflow_status_partition_dequeue_v3 ON crove_dbos.workflow_status USING btree (queue_name, status, queue_partition_key, priority, created_at, workflow_uuid) INCLUDE (application_name) WHERE ((status = ANY (ARRAY['ENQUEUED'::text, 'PENDING'::text])) AND (queue_partition_key IS NOT NULL));
CREATE INDEX idx_workflow_status_pending ON crove_dbos.workflow_status USING btree (created_at) WHERE (status = 'PENDING'::text);
CREATE INDEX idx_workflow_status_rate_limited ON crove_dbos.workflow_status USING btree (queue_name, started_at_epoch_ms) WHERE (rate_limited = true);
CREATE INDEX idx_workflow_status_schedule_name ON crove_dbos.workflow_status USING btree (schedule_name) WHERE (schedule_name IS NOT NULL);
CREATE INDEX idx_workflow_status_started_at ON crove_dbos.workflow_status USING btree (started_at_epoch_ms) WHERE (started_at_epoch_ms IS NOT NULL);
CREATE INDEX idx_workflow_topic ON crove_dbos.notifications USING btree (destination_uuid, topic);
CREATE UNIQUE INDEX uq_application_versions_owner_version ON crove_dbos.application_versions USING btree (application_name, version_name) WHERE (application_name IS NOT NULL);
CREATE UNIQUE INDEX uq_application_versions_unclaimed_version ON crove_dbos.application_versions USING btree (version_name) WHERE (application_name IS NULL);
CREATE UNIQUE INDEX uq_workflow_status_dedup_id ON crove_dbos.workflow_status USING btree (queue_name, deduplication_id) WHERE (deduplication_id IS NOT NULL);
CREATE INDEX workflow_status_created_at_index ON crove_dbos.workflow_status USING btree (created_at);
CREATE TRIGGER dbos_notifications_trigger AFTER INSERT ON crove_dbos.notifications FOR EACH ROW EXECUTE FUNCTION crove_dbos.notifications_function();
ALTER TABLE ONLY crove_dbos.notifications
    ADD CONSTRAINT notifications_destination_uuid_fkey FOREIGN KEY (destination_uuid) REFERENCES crove_dbos.workflow_status(workflow_uuid) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY crove_dbos.streams
    ADD CONSTRAINT streams_workflow_uuid_fkey FOREIGN KEY (workflow_uuid) REFERENCES crove_dbos.workflow_status(workflow_uuid) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY crove_dbos.workflow_events_history
    ADD CONSTRAINT workflow_events_history_workflow_uuid_fkey FOREIGN KEY (workflow_uuid) REFERENCES crove_dbos.workflow_status(workflow_uuid) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY crove_dbos.workflow_events
    ADD CONSTRAINT workflow_events_workflow_uuid_fkey FOREIGN KEY (workflow_uuid) REFERENCES crove_dbos.workflow_status(workflow_uuid) ON UPDATE CASCADE ON DELETE CASCADE;
