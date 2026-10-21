-- Content categories that own queue slots (issue #745). Idempotent; applied files stay untouched.
--
-- crove_social.queue_slot.label_id  the post label (#639) a slot is kept for: posts with that label take the next free
--                                    slot of their label first, then an open slot; other posts take open slots only.
--                                    NULL: open to every post, as before. A label deleted leaves its slots open.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.queue_slot ADD COLUMN IF NOT EXISTS label_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'queue_slot_label_fk' AND conrelid = 'crove_social.queue_slot'::regclass) THEN
    ALTER TABLE crove_social.queue_slot
      ADD CONSTRAINT queue_slot_label_fk FOREIGN KEY (org_id, label_id) REFERENCES crove_social.label (org_id, id) ON DELETE SET NULL (label_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS queue_slot_label_idx ON crove_social.queue_slot (org_id, label_id) WHERE label_id IS NOT NULL;
