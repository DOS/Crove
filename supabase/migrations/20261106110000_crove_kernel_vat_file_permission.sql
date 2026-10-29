-- Crove kernel (issue #1508, from #1479 / #1400): the chief accountants may mark the VAT return filed. Idempotent;
-- applied files stay untouched.
--
-- finance.vat.return_mark (the 01/GTGT filed mark, which feeds the next return's carried-in amount) was open to owners
-- and admins only, so a chief accountant who files the return could not record it. finance.vat.file grants that:
--   finance.chief_accountant         for every legal entity (an org-wide assignment);
--   finance.entity_chief_accountant  for the legal entities it is assigned (#1507): a VAT return is one entity's.
-- The command admits its holders per entity (permissionScope 'legal_entity') and the database's guard on
-- crove_finance.vat_return_filed checks the same (20261106120000_crove_finance_vat_return_filers.sql).
SET LOCAL lock_timeout = '2s';

INSERT INTO crove_kernel.role_permission (role_key, permission) VALUES
  ('finance.chief_accountant', 'finance.vat.file'),
  ('finance.entity_chief_accountant', 'finance.vat.file')
ON CONFLICT (role_key, permission) DO NOTHING;
