-- Campaign labels (#1169): since #1159 a label is the org's campaign, and now it may carry the campaign's dates and the
-- UTM campaign and medium its posts' links should carry, so one typo no longer splits a campaign in the analytics.
-- Owners and admins set them (social.label.create and .update check who); a label without them keeps NULL in all four
-- and behaves as before. Idempotent.
--
-- starts_on, ends_on  the campaign's first and last day, both included, in each post's own time zone; either may be
--                     open. The end is on or after the start when both are set.
-- utm_campaign        the utm_campaign the posts' links should carry; a post given the label gets it as an unsaved
--                     change in its UTM fields when those are empty.
-- utm_medium          its utm_medium; only with a campaign.
--
-- Both tags follow the TAG rule of modules/social/src/domain/utm.ts as closely as a PostgreSQL pattern can: 1 to 100
-- characters, NFC, no space separator at either end, and only letters (Unicode, through the pg_c_utf8 collation so the
-- answer never depends on the database's locale), ASCII digits, space separators and the same punctuation. The command
-- checks this pattern as well as TAG, so whatever it accepts the table accepts.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.label ADD COLUMN IF NOT EXISTS starts_on date;
ALTER TABLE crove_social.label ADD COLUMN IF NOT EXISTS ends_on date;
ALTER TABLE crove_social.label ADD COLUMN IF NOT EXISTS utm_campaign text;
ALTER TABLE crove_social.label ADD COLUMN IF NOT EXISTS utm_medium text;

-- NOT VALID: added without scanning the table under its exclusive lock; validated below (every existing row has NULL
-- in the new columns).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.label'::regclass AND conname = 'label_campaign_dates_check') THEN
    ALTER TABLE crove_social.label ADD CONSTRAINT label_campaign_dates_check
      CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.label'::regclass AND conname = 'label_utm_campaign_check') THEN
    ALTER TABLE crove_social.label ADD CONSTRAINT label_utm_campaign_check
      CHECK (
        utm_campaign IS NULL
        OR (
          utm_campaign IS NFC NORMALIZED
          AND (utm_campaign COLLATE pg_c_utf8) ~ '^[[:alpha:]0-9    -   　_.,:;!?''()/+&%@#-]{1,100}$'
          AND utm_campaign !~ '^[    -   　]|[    -   　]$'
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.label'::regclass AND conname = 'label_utm_medium_check') THEN
    ALTER TABLE crove_social.label ADD CONSTRAINT label_utm_medium_check
      CHECK (
        utm_medium IS NULL
        OR (
          utm_campaign IS NOT NULL
          AND utm_medium IS NFC NORMALIZED
          AND (utm_medium COLLATE pg_c_utf8) ~ '^[[:alpha:]0-9    -   　_.,:;!?''()/+&%@#-]{1,100}$'
          AND utm_medium !~ '^[    -   　]|[    -   　]$'
        )
      ) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.label VALIDATE CONSTRAINT label_campaign_dates_check;
ALTER TABLE crove_social.label VALIDATE CONSTRAINT label_utm_campaign_check;
ALTER TABLE crove_social.label VALIDATE CONSTRAINT label_utm_medium_check;

-- The columns social.label.update writes: the name and colour (20261021130000) and now the campaign's four. Who made
-- the label and when stay as they were.
GRANT UPDATE (name, color, starts_on, ends_on, utm_campaign, utm_medium) ON crove_social.label TO crove_tenant;
