-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #1678 review of #1955): an email address in free text is matched as a whole address on letters
-- outside ASCII too. Idempotent; applied files stay untouched.
--
-- crove_kernel.text_mention_pattern (20261106200000) bounded an address by ASCII only: nothing of [a-z0-9] and the
-- local part's punctuation just before it, no [a-z0-9_-] just after it. So ab@x.example was found inside
-- đab@x.example, an address of its own (RFC 6531 allows letters outside ASCII), and the erasure (#1678, part 2) would
-- have edited a fragment out of it. Latin letters with diacritics now count as part of an address on both sides:
-- U+00C0 to U+024F but the signs × and ÷ (Latin-1 letters, Latin Extended-A and -B), the combining diacritical marks
-- U+0300 to U+036F (Vietnamese written decomposed) and Latin Extended Additional U+1E00 to U+1EFF (the Vietnamese
-- letters with two marks). Named as ranges rather than [[:alpha:]], whose reach depends on the database's locale (a C
-- locale knows ASCII only). Only Latin: the blocks of other scripts mix letters with their punctuation (the Arabic
-- question mark U+061F after an address must still end it), and a miss is worse than a rare match next to a letter of
-- another script, since the erasure acts only on what is found. Everything else (curly quotes, the ellipsis, «», no-break
-- spaces, CJK punctuation, emoji) still parts an address from the text around it. The phone and ID pattern is
-- unchanged.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.text_mention_pattern(p_kind text, p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  -- The spaces people put between digits, named one by one rather than as [[:space:]], whose reach depends on the
  -- database's locale: space, tab, line breaks, and the no-break spaces a pasted number often carries (U+00A0,
  -- U+2007, U+202F) and U+FEFF.
  v_space constant text := ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(160) || pg_catalog.chr(8199) || pg_catalog.chr(8239) || pg_catalog.chr(65279);
  -- The same on one line: what may part two digits of one number at a number's edge (a line break parts two numbers).
  v_inline constant text := ' ' || pg_catalog.chr(160) || pg_catalog.chr(8199) || pg_catalog.chr(8239) || pg_catalog.chr(65279);
  v_sep constant text := '[' || v_space || '.()-]{0,3}';
  -- Latin letters outside ASCII, as ranges inside a bracket expression (see above): U+00C0-U+00D6, U+00D8-U+00F6,
  -- U+00F8-U+024F, U+0300-U+036F and U+1E00-U+1EFF.
  v_letters constant text := pg_catalog.chr(192) || '-' || pg_catalog.chr(214) || pg_catalog.chr(216) || '-' || pg_catalog.chr(246)
    || pg_catalog.chr(248) || '-' || pg_catalog.chr(591) || pg_catalog.chr(768) || '-' || pg_catalog.chr(879)
    || pg_catalog.chr(7680) || '-' || pg_catalog.chr(7935);
  v_local text;
  v_intl text;
BEGIN
  IF p_kind = 'email' THEN
    IF p_value IS NULL OR p_value !~ '^[^[:space:]@]+@[^[:space:]@]+$' OR p_value <> pg_catalog.lower(p_value) OR pg_catalog.length(p_value) > 320 THEN
      RAISE EXCEPTION 'TEXT_MENTION_VALUE' USING ERRCODE = '22023';
    END IF;
    -- Nothing an address's local part may hold just before it (RFC 5322 atext and the dot, and a letter outside ASCII),
    -- so brien@x.example is not found in o'brien@x.example, tag#brien@x.example or đbrien@x.example. In the value only
    -- ASCII punctuation is escaped, each with a backslash, which makes it literal; a letter outside ASCII is never a
    -- regex character and stays as it is (a backslash before a letter would be an escape). After it: no letter, digit,
    -- _ or -, nor a dot that one follows.
    RETURN '(?<![a-z0-9!#$%&''*+/=?^_`{|}~.' || v_letters || '-])' || pg_catalog.regexp_replace(p_value, '([!-/:-?[-`{-~])', '\\\1', 'g')
      || '(?![a-z0-9_' || v_letters || '-])(?!\.[a-z0-9' || v_letters || '])';
  ELSIF p_kind = 'digits' THEN
    IF p_value IS NULL OR p_value !~ '^[0-9]{8,15}$' THEN
      RAISE EXCEPTION 'TEXT_MENTION_VALUE' USING ERRCODE = '22023';
    END IF;
    -- A phone (10 or 11 digits from a leading 0, as Vietnam writes them) is also found with 84 in place of the 0, and
    -- a value given with 84 also with the 0. Any other value (a 12-digit national ID, a 13-digit branch tax code) is
    -- found only as it is: 000091777665 is not 8400091777665.
    v_local := CASE WHEN p_value ~ '^84[0-9]{9,10}$' THEN '0' || pg_catalog.substr(p_value, 3) ELSE p_value END;
    v_intl := CASE WHEN v_local ~ '^0[0-9]{9,10}$' THEN '84' || pg_catalog.substr(v_local, 2) ELSE v_local END;
    -- An opening bracket just before the digits is part of the number ("(028) 3829 1234"), so an edit leaves none.
    -- No digit just before or after, nor one a single space, dot or dash away, so the value is not found inside a
    -- longer number written in groups (000 091 777 665); a line break or two separators part two numbers, so a list
    -- ("1. 0912 345 678", one number a line) still finds each.
    RETURN '(?<![0-9][' || v_inline || '.-]?)(?:\(?' || pg_catalog.array_to_string(pg_catalog.regexp_split_to_array(v_local, ''), v_sep)
      || '|\+?' || pg_catalog.array_to_string(pg_catalog.regexp_split_to_array(v_intl, ''), v_sep) || ')(?![' || v_inline || '.-]?[0-9])';
  END IF;
  RAISE EXCEPTION 'TEXT_MENTION_KIND' USING ERRCODE = '22023';
END $$;
REVOKE ALL ON FUNCTION crove_kernel.text_mention_pattern(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.text_mention_pattern(text, text) TO crove_tenant;
