-- Crove kernel (issue #1678, notes step N9; reused by #1948): whether a free text mentions a person's email address,
-- phone number, tax code or national ID, and the same text with the value edited out. The personal-data finder (#923)
-- compared whole values in email, phone and tax-code columns; free text (a note's body, an activity line, a journal
-- description) holds a value among other words. Idempotent; applied files stay untouched.
--
-- crove_kernel.text_mention_pattern(kind, value)       the regular expression a value is matched with (below)
-- crove_kernel.text_mentions(text, kind, value)        true when the text mentions the value
-- crove_kernel.text_redact(text, kind, value, mark)    the text with every mention replaced by mark
--
-- kind and value are what the finder's probe holds (packages/kernel/src/personal-data.ts, personalDataProbe):
--   - 'email': the address in lower case. Matched without regard to case, as a whole address: nothing an address's
--     local part may hold just before it, and no letter, digit, _ or - just after it, nor a dot that a letter or digit
--     follows, so ab@x.com is not found in cab@x.com, o'ab@x.com or ab@x.com.vn, and is found at the end of a sentence
--     ("... ab@x.com.").
--   - 'digits': 8 to 15 digits (a phone number, a tax code or a national ID). Found with up to three of space . ( ) -
--     between any two digits, as people write them ("0901 234 567", "(028) 3829.1234", "0101234567-001"), an opening
--     bracket just before them, and no digit next to either end (nor one a single space, dot or dash away). A phone
--     number (10 or 11 digits) is found with or without Vietnam's +84 in place of the leading 0.
-- Any other kind or a value of another shape raises (22023) instead of matching nothing, so a caller's mistake is
-- never read as "not found". The value is escaped, never read as a pattern. Invoker functions without side effects,
-- for the tenant role: they read nothing but their arguments.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.text_mention_pattern(p_kind text, p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_sep constant text := '[[:space:].()-]{0,3}';
  v_local text;
  v_intl text;
BEGIN
  IF p_kind = 'email' THEN
    IF p_value IS NULL OR p_value !~ '^[^[:space:]@]+@[^[:space:]@]+$' OR p_value <> pg_catalog.lower(p_value) OR pg_catalog.length(p_value) > 320 THEN
      RAISE EXCEPTION 'TEXT_MENTION_VALUE' USING ERRCODE = '22023';
    END IF;
    -- Every character but a letter, a digit and @ escaped: a backslash before one of them is always that character.
    -- Nothing an address's local part may hold just before it (RFC 5322 atext and the dot), so brien@x.com is not found
    -- in o'brien@x.com or tag#brien@x.com.
    RETURN '(?<![a-z0-9!#$%&''*+/=?^_`{|}~.-])' || pg_catalog.regexp_replace(p_value, '([^a-z0-9@])', '\\\1', 'g') || '(?![a-z0-9_-])(?!\.[a-z0-9])';
  ELSIF p_kind = 'digits' THEN
    IF p_value IS NULL OR p_value !~ '^[0-9]{8,15}$' THEN
      RAISE EXCEPTION 'TEXT_MENTION_VALUE' USING ERRCODE = '22023';
    END IF;
    -- A phone (10 or 11 digits from a leading 0, as Vietnam writes them) is also found with 84 in place of the 0, and
    -- a value given with 84 also with the 0. Any other value (a 12-digit national ID, a 13-digit branch tax code) is
    -- found only as it is: 001091777665 is not 8401091777665.
    v_local := CASE WHEN p_value ~ '^84[0-9]{9,10}$' THEN '0' || pg_catalog.substr(p_value, 3) ELSE p_value END;
    v_intl := CASE WHEN v_local ~ '^0[0-9]{9,10}$' THEN '84' || pg_catalog.substr(v_local, 2) ELSE v_local END;
    -- An opening bracket just before the digits is part of the number ("(028) 3829 1234"), so an edit leaves none.
    -- No digit just before or after, nor one a single space, dot or dash away, so the value is not found inside a
    -- longer number written in groups (001 091 777 665); a line break or two separators part two numbers, so a list
    -- ("1. 0912 345 678", one number a line) still finds each.
    RETURN '(?<![0-9][ .-]?)(?:\(?' || pg_catalog.array_to_string(pg_catalog.regexp_split_to_array(v_local, ''), v_sep)
      || '|\+?' || pg_catalog.array_to_string(pg_catalog.regexp_split_to_array(v_intl, ''), v_sep) || ')(?![ .-]?[0-9])';
  END IF;
  RAISE EXCEPTION 'TEXT_MENTION_KIND' USING ERRCODE = '22023';
END $$;
REVOKE ALL ON FUNCTION crove_kernel.text_mention_pattern(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.text_mention_pattern(text, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.text_mentions(p_text text, p_kind text, p_value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_pattern constant text := crove_kernel.text_mention_pattern(p_kind, p_value);
BEGIN
  RETURN p_text IS NOT NULL AND p_text ~* v_pattern;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.text_mentions(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.text_mentions(text, text, text) TO crove_tenant;

-- The mark replaces the whole mention and is taken literally: in a replacement a backslash starts an escape (\1, \&
-- for the match), so each one is doubled; a bare & is already literal.
CREATE OR REPLACE FUNCTION crove_kernel.text_redact(p_text text, p_kind text, p_value text, p_mark text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_pattern constant text := crove_kernel.text_mention_pattern(p_kind, p_value);
BEGIN
  IF p_text IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.regexp_replace(p_text, v_pattern, pg_catalog.replace(COALESCE(p_mark, ''), '\', '\\'), 'gi');
END $$;
REVOKE ALL ON FUNCTION crove_kernel.text_redact(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.text_redact(text, text, text, text) TO crove_tenant;
