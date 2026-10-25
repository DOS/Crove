-- Crove Social (issue #1360): find posts without typing Vietnamese marks. The Social lists, the calendar, the board and
-- saved views search through postFilterQuery (modules/social/src/post-filter.ts), which matched the typed text with
-- ILIKE, so "khuyen mai" did not find "Khuyến mãi". Each searched text now has a stored copy folded by
-- crove_kernel.search_fold (#673: NFC, the Vietnamese letters with marks and đ to their base letter, lower case, every
-- run of other characters to one space), and the search matches the folded term inside it. Idempotent.
--
--   post.search_text           the post's title and body, folded
--   post_variant.search_text   a channel's own title and body, folded (empty when it shows the post's)
--
-- search_fold is IMMUTABLE (pure, no table, no setting), so it can back a generated column. The copies are stored rather
-- than folded in the query: folding costs some 40 microseconds a row and a body may hold 100,000 characters, while a
-- stored copy makes the test a plain LIKE. No index: a term is matched anywhere in the text (a substring, not a word or
-- a prefix), which neither a btree nor the 'simple' tsvector of #673 can answer, and the org's rows are read through
-- the primary key's org_id prefix already (a 5,000-post org within the DB test's budget, social-search-fold.db.test.ts).
-- Media file names are folded in the query instead: the library list is paged by time, so it stops at a page.
--
-- Adding a stored column rewrites the two tables once under an ACCESS EXCLUSIVE lock (about 150 microseconds a row on
-- PostgreSQL 17, so 100,000 posts hold it some 15 seconds; Social is not live yet); row triggers do not fire for that. The
-- columns are generated, so no role writes them, and they hold nothing a reader of the row could not already read. The
-- org export leaves them out, as the finance search columns. A later CREATE OR REPLACE of crove_kernel.search_fold leaves
-- the stored values as they were (rewrite them with an UPDATE of title), and dropping it with CASCADE drops both columns.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post
  ADD COLUMN IF NOT EXISTS search_text text GENERATED ALWAYS AS (crove_kernel.search_fold(COALESCE(title, '') || ' ' || body)) STORED;
ALTER TABLE crove_social.post_variant
  ADD COLUMN IF NOT EXISTS search_text text GENERATED ALWAYS AS (crove_kernel.search_fold(COALESCE(title, '') || ' ' || COALESCE(body, ''))) STORED;
