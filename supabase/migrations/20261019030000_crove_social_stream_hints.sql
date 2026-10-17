-- Realtime hints for Crove Social (issue #69 design, Social plan S5): a change of a post, which every social command
-- makes when it refreshes the post's status, sends `<org_id> social_post <post id>` on crove_stream, so an open
-- calendar or post page re-fetches through its normal authorized queries. Ids only, as every hint. Idempotent.
SET LOCAL lock_timeout = '2s';

DROP TRIGGER IF EXISTS stream_hint ON crove_social.post;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_social.post
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('social_post', 'id');
