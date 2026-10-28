-- Invalidation hints honor the legal-entity scope (issue #1692): the finance tables under le_scope name their entity
-- column in the stream hint, so their hints carry the row's legal entity as a fourth field and the API drops them for
-- streams whose scope leaves it out. The payload format and the trigger function are in the previous file,
-- 20261103080000_crove_kernel_stream_legal_entity.sql. Idempotent; applied files stay untouched.
--     journal_entry  crove_finance.journal_entry           id           legal_entity_id
--     document       crove_finance.purchase_document       id           legal_entity_id
--                    crove_finance.purchase_document_void  document_id  legal_entity_id (the voided document's)
SET LOCAL lock_timeout = '2s';

DROP TRIGGER IF EXISTS stream_hint ON crove_finance.journal_entry;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_finance.journal_entry
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('journal_entry', 'id', 'legal_entity_id');
DROP TRIGGER IF EXISTS stream_hint ON crove_finance.purchase_document;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_finance.purchase_document
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('document', 'id', 'legal_entity_id');
DROP TRIGGER IF EXISTS stream_hint ON crove_finance.purchase_document_void;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_finance.purchase_document_void
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('document', 'document_id', 'legal_entity_id');
