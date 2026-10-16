-- Crove Social: posts, their per-channel variants, review decisions and posting queues (Social plan §3.2, step S3,
-- issue #233; design compared with Postiz, OpenPost and BrightBean in docs/plan/social-research.md §5). Idempotent.
--
-- post           the base content of one piece of work: text, title, link, time zone and default schedule. Its
--                status is a summary the commands derive from its variants.
-- post_variant   one per channel connection of a post. Nullable overrides: NULL inherits the post's value. Each variant
--                has its own lifecycle (review, schedule, publish), its own revision and the hash of its effective
--                content; a change that reaches the effective content bumps the revision and sends it back to draft.
-- post_approval  append-only review decisions, one row per variant decision, with the revision, the content hash and
--                a snapshot of what the reviewer saw. A publish needs a latest decision 'approved' matching the
--                variant as it is.
-- queue          one per channel connection: its posting time zone.
-- queue_slot     weekly slots of a queue (ISO weekday, minute of the local day).
--
-- Published and in-flight variants are history: tenant roles cannot delete posts or variants; work is cancelled.
SET LOCAL lock_timeout = '2s';

CREATE SCHEMA IF NOT EXISTS crove_social;
GRANT USAGE ON SCHEMA crove_social TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_social.post (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
  title text CHECK (title IS NULL OR length(title) <= 500),
  link_url text CHECK (link_url IS NULL OR (length(link_url) <= 2000 AND link_url ~ '^https?://')),
  -- Who wrote it: a person, or AI (tainted until a person approves each variant).
  origin text NOT NULL DEFAULT 'human' CHECK (origin IN ('human', 'ai')),
  actor_origin text NOT NULL DEFAULT 'ui' CHECK (actor_origin IN ('ui', 'api', 'mcp', 'agent', 'system')),
  tainted boolean NOT NULL DEFAULT false,
  author_user_id uuid,
  time_zone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh' CHECK (length(time_zone) BETWEEN 1 AND 64),
  -- Default publish time of its variants; a variant may override it or take a queue slot.
  scheduled_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS post_status_idx ON crove_social.post (org_id, status, updated_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_social.post');
REVOKE DELETE ON crove_social.post FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_social.post_variant (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  post_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  -- The connection's provider, copied at creation (a connection never changes provider), so rules and hashes need
  -- no join into the kernel.
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 1000),
  body text CHECK (body IS NULL OR length(body) <= 100000),
  title text CHECK (title IS NULL OR length(title) <= 500),
  link_url text CHECK (link_url IS NULL OR (length(link_url) <= 2000 AND link_url ~ '^https?://')),
  -- History (published, cancelled) keeps the content it had: its own columns hold it, NULL then means "none", and
  -- base edits no longer reach it.
  content_frozen boolean NOT NULL DEFAULT false,
  -- The commands cap settings at 16 KiB of JSON; jsonb's text form adds spaces, so the column allows twice that.
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 32768),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'scheduled', 'publishing', 'processing',
    'published', 'failed', 'ambiguous', 'needs_attention', 'paused', 'cancelled')),
  scheduled_at timestamptz,
  queue_slot_at timestamptz,
  -- Publish attempt: a return to scheduled after a publish began starts a new one (fresh external_call keys).
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  external_post_id text CHECK (external_post_id IS NULL OR length(external_post_id) <= 500),
  external_url text CHECK (external_url IS NULL OR length(external_url) <= 2000),
  published_at timestamptz,
  error_kind text CHECK (error_kind IS NULL OR error_kind IN ('token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown')),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 200),
  error_http_status integer CHECK (error_http_status IS NULL OR error_http_status BETWEEN 100 AND 599),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 2000),
  -- What the user should do about the error (reconnect, shorten, retry later...), as a stable key the app localizes.
  error_action text CHECK (error_action IS NULL OR error_action ~ '^[a-z][a-z0-9_]{0,63}$'),
  error_retry_at timestamptz,
  next_check_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT post_variant_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE,
  CONSTRAINT post_variant_connection_fk FOREIGN KEY (org_id, channel_connection_id)
    REFERENCES crove_kernel.channel_connection (org_id, id),
  -- Lets a decision name its variant and the variant's post in one foreign key.
  CONSTRAINT post_variant_post_uq UNIQUE (org_id, id, post_id)
);
-- One live variant per connection in a post; a cancelled one is history and the connection can be added again.
CREATE UNIQUE INDEX IF NOT EXISTS post_variant_live_per_connection ON crove_social.post_variant (org_id, post_id, channel_connection_id)
  WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS post_variant_connection_idx ON crove_social.post_variant (org_id, channel_connection_id, status);
-- The calendar and the publisher read by effective time.
CREATE INDEX IF NOT EXISTS post_variant_schedule_idx ON crove_social.post_variant (org_id, (coalesce(queue_slot_at, scheduled_at)))
  WHERE status IN ('approved', 'scheduled', 'paused');
-- One queued variant per slot of a connection's queue.
CREATE UNIQUE INDEX IF NOT EXISTS post_variant_slot_uq ON crove_social.post_variant (org_id, channel_connection_id, queue_slot_at)
  WHERE queue_slot_at IS NOT NULL AND status NOT IN ('cancelled', 'published', 'failed');
SELECT crove_kernel.apply_tenant_rls('crove_social.post_variant');
REVOKE DELETE ON crove_social.post_variant FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_social.post_approval (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  post_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected')),
  comment text CHECK (comment IS NULL OR length(comment) <= 2000),
  decided_by uuid NOT NULL,
  actor_origin text NOT NULL DEFAULT 'ui' CHECK (actor_origin IN ('ui', 'api', 'mcp', 'agent', 'system')),
  -- The effective content the reviewer saw, kept as evidence; a later edit never changes it.
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  -- The decision's variant belongs to the decision's post.
  CONSTRAINT post_approval_variant_fk FOREIGN KEY (org_id, variant_id, post_id) REFERENCES crove_social.post_variant (org_id, id, post_id)
);
CREATE INDEX IF NOT EXISTS post_approval_variant_idx ON crove_social.post_approval (org_id, variant_id, created_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_social.post_approval', true);
SELECT crove_kernel.make_append_only('crove_social.post_approval');

CREATE TABLE IF NOT EXISTS crove_social.queue (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  channel_connection_id uuid NOT NULL,
  time_zone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh' CHECK (length(time_zone) BETWEEN 1 AND 64),
  paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT queue_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id),
  CONSTRAINT queue_one_per_connection UNIQUE (org_id, channel_connection_id)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.queue');

CREATE TABLE IF NOT EXISTS crove_social.queue_slot (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  queue_id uuid NOT NULL,
  -- ISO weekday: 1 = Monday ... 7 = Sunday; minute of the local day.
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  minute smallint NOT NULL CHECK (minute BETWEEN 0 AND 1439),
  label text CHECK (label IS NULL OR length(label) <= 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT queue_slot_queue_fk FOREIGN KEY (org_id, queue_id) REFERENCES crove_social.queue (org_id, id) ON DELETE CASCADE,
  CONSTRAINT queue_slot_unique UNIQUE (org_id, queue_id, weekday, minute)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.queue_slot');
