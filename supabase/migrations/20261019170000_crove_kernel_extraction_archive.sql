-- Bulk intake (issue #314): a ZIP archive is stored as a file like any upload, and its one extraction run records
-- that the archive was opened, with method 'archive'. Idempotent; applied files stay untouched.
--
-- crove_kernel.extraction.method 'archive'   the run opened a ZIP in the parsing sandbox and filed its entries as
--                                            files of their own (kernel.file.archive.record, worker only). result
--                                            holds { "entries": [{ name, outcome, reason, fileId }] }; it never has
--                                            a proposal, and an archive is never read again.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.extraction DROP CONSTRAINT IF EXISTS extraction_method_check;
ALTER TABLE crove_kernel.extraction ADD CONSTRAINT extraction_method_check
  CHECK (method IN ('einvoice_xml', 'pdf_text_ai', 'image_ai', 'unsupported', 'archive'));
