-- Crove kernel (issue #1948, PDPL; shared with notes step N9, #1678): finding and redacting a person's email, phone or
-- ID inside free text. Idempotent; applied files stay untouched.
--
-- The personal-data finder (packages/kernel/src/personal-data.ts) compares whole values in email, phone and tax-code
-- columns. Free text (an activity line, a comment, a note) quotes a value inside a sentence, spelled any way. These
-- functions give that match once, for queries and for definers alike; packages/kernel/src/personal-data.ts has their
-- TypeScript twins (piiTextPattern, piiTextMatches, piiTextRedact), and one case table runs against both
-- (apps/kernel/test/pii-text-cases.ts).
--
-- crove_kernel.pii_text_pattern(value)
--     The regular expression (an ARE that JavaScript reads the same way) for the value the person gave, or NULL when it
--     is not one. The value is read as personalDataProbe reads it:
--       - an email (one @, no space): the address, case aside, not inside a longer address. No address character just
--         before it, and after it no address character or a dot that starts another label: ab@x.com does not match
--         cab@x.com or ab@x.com.vn, and does match "ab@x.com." at the end of a sentence.
--       - a phone, tax code or national ID (8 to 15 digits, spaces, dots, dashes and brackets allowed): its digits in
--         order, with up to two of those separators between any two of them, and no digit just before or after, so it
--         never matches inside a longer number. A number written with Vietnam's +84 or 84 also matches its 0 form, and
--         the other way round.
-- crove_kernel.pii_text_matches(text, value)  whether the text holds the value (false for NULL or a value that is none).
-- crove_kernel.pii_text_redact(text, value)   the text with every match replaced by '[đã xóa]' (PII_REDACTED).
--
-- IMMUTABLE and SECURITY INVOKER: they read no table. EXECUTE for crove_tenant (the finder's queries) and the definers'
-- owner, which owns them.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.pii_text_pattern(p_value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_value text := pg_catalog.regexp_replace(coalesce(p_value, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_digits text;
  v_forms text[];
  v_alternatives text[] := ARRAY[]::text[];
  v_form text;
BEGIN
  IF v_value ~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
    RETURN '(?<![a-z0-9._%+-])'
      || pg_catalog.regexp_replace(pg_catalog.lower(v_value), '([].^$*+?()[{}|\\])', '\\\1', 'g')
      || '(?![a-z0-9_-]|\.[a-z0-9])';
  END IF;
  IF v_value !~ '^[+(0-9][0-9[:space:]().-]{7,24}$' THEN
    RETURN NULL;
  END IF;
  v_digits := pg_catalog.regexp_replace(v_value, '[^0-9]', '', 'g');
  IF pg_catalog.length(v_digits) NOT BETWEEN 8 AND 15 THEN
    RETURN NULL;
  END IF;
  v_forms := ARRAY[v_digits];
  IF v_digits LIKE '84%' AND pg_catalog.length(v_digits) >= 10 THEN
    v_forms := v_forms || ('0' || pg_catalog.substr(v_digits, 3));
  ELSIF v_digits LIKE '0%' THEN
    v_forms := v_forms || ('84' || pg_catalog.substr(v_digits, 2));
  END IF;
  FOREACH v_form IN ARRAY v_forms LOOP
    -- A form with 84 in front may be written with a +.
    v_alternatives := v_alternatives
      || ((CASE WHEN v_form LIKE '84%' THEN '\+?' ELSE '' END)
          || pg_catalog.array_to_string(pg_catalog.regexp_split_to_array(v_form, ''), '[\s.()-]{0,2}'));
  END LOOP;
  RETURN '(?<![0-9])(?:' || pg_catalog.array_to_string(v_alternatives, '|') || ')(?![0-9])';
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.pii_text_matches(p_text text, p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(p_text ~* crove_kernel.pii_text_pattern(p_value), false)
$$;

CREATE OR REPLACE FUNCTION crove_kernel.pii_text_redact(p_text text, p_value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN crove_kernel.pii_text_pattern(p_value) IS NULL THEN p_text
              ELSE pg_catalog.regexp_replace(p_text, crove_kernel.pii_text_pattern(p_value), '[đã xóa]', 'gi') END
$$;

REVOKE ALL ON FUNCTION crove_kernel.pii_text_pattern(text), crove_kernel.pii_text_matches(text, text), crove_kernel.pii_text_redact(text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.pii_text_pattern(text), crove_kernel.pii_text_matches(text, text), crove_kernel.pii_text_redact(text, text)
  TO crove_tenant;
