-- Crove's own short links with click counts (issue #706). Idempotent; applied files stay untouched.
--
-- crove_social.channel_policy.short_links  whether a channel's posts send their link through Crove (off by default).
-- crove_social.short_link        a variant's link as Crove shortened it when it went out: a random code, unique across
--                                orgs, and the target with its UTM tags, fixed then and never changed. One per variant
--                                and revision, so a retry, a status check or a reconcile sends the same link. The worker
--                                writes it (social.publish.begin); it goes with its post.
-- crove_social.short_link_click  a link's clicks per day (UTC). Only short_link_hit writes them: no address, no
--                                browser, nothing of the visitor is kept, only the count.
-- crove_social.short_link_hit    the redirect's definer: for a well-formed code of an active org, the target, and with
--                                p_count one more click of the day. It returns the target and nothing else.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.channel_policy ADD COLUMN IF NOT EXISTS short_links boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS crove_social.short_link (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9]{10,16}$'),
  variant_id uuid NOT NULL,
  -- The variant's revision that went out (the worker always names it; 1, a variant's first, by default).
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  post_id uuid NOT NULL,
  target_url text NOT NULL CHECK (target_url ~ '^https?://' AND length(target_url) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT short_link_variant_uq UNIQUE (org_id, variant_id, revision),
  CONSTRAINT short_link_variant_fk FOREIGN KEY (org_id, variant_id) REFERENCES crove_social.post_variant (org_id, id) ON DELETE CASCADE,
  CONSTRAINT short_link_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE
);
-- Codes are looked up without an org (the redirect), so they are unique across orgs.
CREATE UNIQUE INDEX IF NOT EXISTS short_link_code_uq ON crove_social.short_link (code);
CREATE INDEX IF NOT EXISTS short_link_post_idx ON crove_social.short_link (org_id, post_id);
SELECT crove_kernel.apply_tenant_rls('crove_social.short_link');
-- A short link never changes: its target is what went out.
REVOKE UPDATE ON crove_social.short_link FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_social.short_link_click (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  short_link_id uuid NOT NULL,
  day date NOT NULL,
  clicks bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  PRIMARY KEY (org_id, id),
  CONSTRAINT short_link_click_day_uq UNIQUE (org_id, short_link_id, day),
  CONSTRAINT short_link_click_link_fk FOREIGN KEY (org_id, short_link_id) REFERENCES crove_social.short_link (org_id, id) ON DELETE CASCADE
);
SELECT crove_kernel.apply_tenant_rls('crove_social.short_link_click');
-- Members read the counts; only the redirect's definer writes them.
REVOKE INSERT, UPDATE, DELETE ON crove_social.short_link_click FROM crove_tenant;

CREATE OR REPLACE FUNCTION crove_social.short_link_hit(p_code text, p_count boolean)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link record;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[A-Za-z0-9]{10,16}$' THEN
    RETURN NULL;
  END IF;
  SELECT l.org_id, l.id, l.target_url INTO v_link
  FROM crove_social.short_link l
  JOIN crove_kernel.tenant t ON t.org_id = l.org_id AND t.status = 'active'
  WHERE l.code = p_code;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF coalesce(p_count, false) THEN
    INSERT INTO crove_social.short_link_click (org_id, short_link_id, day, clicks)
    VALUES (v_link.org_id, v_link.id, (pg_catalog.now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (org_id, short_link_id, day) DO UPDATE SET clicks = crove_social.short_link_click.clicks + 1;
  END IF;
  RETURN v_link.target_url;
END $$;
REVOKE ALL ON FUNCTION crove_social.short_link_hit(text, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.short_link_hit(text, boolean) TO crove_app;
