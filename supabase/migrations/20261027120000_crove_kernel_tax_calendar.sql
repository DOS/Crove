-- Crove kernel (issue #921): the tax calendar of each client, beyond the VAT return. The rules (what is due when) are
-- data in @crove/kernel-contract (tax-calendar.ts); the database holds only what each org decided and what was done.
-- Idempotent; applied files stay untouched.
--
-- crove_kernel.tax_profile           one row per org: the obligations that apply to it, its PIT withholding frequency
--                                    and the last month of its fiscal year. No row means only the VAT return, by the
--                                    org's VAT filing period (#318). Owners and admins set it (kernel.tax_profile.save).
-- crove_kernel.tax_obligation_done   an obligation marked done for one period, by a member (kernel.tax_obligation.done):
--                                    the calendar no longer lists it. At most one per obligation and period; a member
--                                    may take the mark back (kernel.tax_obligation.undo), so rows are deleted, not kept.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.tax_profile (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  obligations text[] NOT NULL DEFAULT '{}'
    CHECK (obligations <@ ARRAY['vat_return', 'pit_withholding', 'cit_provisional', 'cit_finalization', 'pit_finalization', 'financial_statements', 'license_fee']::text[]),
  pit_filing_period text CHECK (pit_filing_period IN ('month', 'quarter')),
  fiscal_year_end_month smallint NOT NULL DEFAULT 12 CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  -- The PIT withholding return needs its frequency.
  CONSTRAINT tax_profile_pit_period CHECK (NOT ('pit_withholding' = ANY (obligations)) OR pit_filing_period IS NOT NULL)
);
-- One row per org, kept by the save command under an advisory lock (as crove_kernel.proposal_policy); readers take the
-- first.
CREATE INDEX IF NOT EXISTS tax_profile_org_idx ON crove_kernel.tax_profile (org_id, created_at, id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.tax_profile');

CREATE TABLE IF NOT EXISTS crove_kernel.tax_obligation_done (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  obligation text NOT NULL
    CHECK (obligation IN ('vat_return', 'pit_withholding', 'cit_provisional', 'cit_finalization', 'pit_finalization', 'financial_statements', 'license_fee')),
  -- The period the obligation covers: a year ("2026"), a month ("2026-09") or a quarter ("2026-Q3").
  period text NOT NULL CHECK (period ~ '^20[0-9]{2}(-(0[1-9]|1[0-2]|Q[1-4]))?$'),
  done_by uuid NOT NULL,
  done_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT tax_obligation_done_uq UNIQUE (org_id, obligation, period)
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.tax_obligation_done');
