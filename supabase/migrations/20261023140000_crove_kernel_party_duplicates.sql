-- Duplicate parties (#887, plan §6 "Deduplication is the R1 command 'mark duplicate'"): a party marked as a duplicate
-- points at the party kept. Nothing is deleted or moved: documents and journal lines keep the party they were recorded
-- with, lists and search show only the kept party, and per-party ledger reports add the duplicate's lines into it.
-- kernel.party.unmark_duplicate clears the link, which undoes all of that.
--
-- One level only: the kept party is never a duplicate itself, and a party that others point at cannot become one.
-- The commands check this under row locks; party_duplicate_guard holds it for every writer.
ALTER TABLE crove_kernel.party ADD COLUMN IF NOT EXISTS duplicate_of uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_duplicate_of_fk' AND conrelid = 'crove_kernel.party'::regclass) THEN
    ALTER TABLE crove_kernel.party
      ADD CONSTRAINT party_duplicate_of_fk FOREIGN KEY (org_id, duplicate_of) REFERENCES crove_kernel.party (org_id, id),
      ADD CONSTRAINT party_duplicate_not_self CHECK (duplicate_of IS DISTINCT FROM id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS party_duplicate_of_idx ON crove_kernel.party (org_id, duplicate_of) WHERE duplicate_of IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_kernel.party_duplicate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.duplicate_of IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM crove_kernel.party k WHERE k.org_id = NEW.org_id AND k.id = NEW.duplicate_of AND k.duplicate_of IS NOT NULL) THEN
    RAISE EXCEPTION 'PARTY_DUPLICATE_CHAIN: the kept party is itself a duplicate' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM crove_kernel.party d WHERE d.org_id = NEW.org_id AND d.duplicate_of = NEW.id) THEN
    RAISE EXCEPTION 'PARTY_DUPLICATE_CHAIN: other parties are duplicates of this one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS party_duplicate_guard ON crove_kernel.party;
CREATE TRIGGER party_duplicate_guard BEFORE INSERT OR UPDATE OF duplicate_of ON crove_kernel.party
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.party_duplicate_guard();
