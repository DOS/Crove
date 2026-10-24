-- The currency reference table (issue #1282, ADR-0021 decision 1, plan §6 "Global reference tables"). Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.currency   ISO 4217 code and minor units: how many decimals the currency uses (0 for VND and JPY, 2 for
--                         USD, at most 4, the scale of crove_finance.amount). The posting definer refuses an amount with
--                         more decimals than the book currency uses (20261029233100). A global reference table with no
--                         org_id: every runtime role reads all of it and none writes it; rows are added by migrations
--                         only and never changed or removed (immutable once published). In the kernel, not in finance,
--                         because kernel tables name currencies too (tenant.base_currency, a legal entity's book
--                         currency later) and a kernel table may not reference a module. The rows match
--                         CURRENCY_MINOR_UNITS in modules/finance/src/domain/money.ts (finance-currency-scale.db.test.ts
--                         compares them).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.currency (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_units smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 4)
);
INSERT INTO crove_kernel.currency (code, minor_units) VALUES
  ('VND', 0), ('JPY', 0), ('KRW', 0),
  ('USD', 2), ('EUR', 2), ('GBP', 2), ('CNY', 2), ('SGD', 2), ('THB', 2),
  ('KWD', 3), ('BHD', 3),
  ('CLF', 4)
ON CONFLICT (code) DO NOTHING;
REVOKE ALL ON crove_kernel.currency FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT SELECT ON crove_kernel.currency TO crove_tenant, crove_app, crove_worker;
SELECT crove_kernel.make_append_only('crove_kernel.currency');
SELECT crove_kernel.agent_write_guard_install('crove_kernel.currency');
