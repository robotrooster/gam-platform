-- Credit Ledger v1: external_account_links (forward-compat scaffold).
--
-- Empty in v1. Populated starting v1.5 when Plaid Liabilities + carrier
-- API integrations begin landing. The table exists now so that the
-- schema is forward-compatible: no migration churn when integrations
-- arrive, and the credit-ledger service already knows where consent
-- and source metadata live.
--
-- A row represents one external account a tenant has connected to GAM
-- for ledger-event sourcing (auto loan at lender X, utility at provider Y,
-- phone bill at carrier Z, etc.). Per-category opt-in: tenants consent
-- to specific categories rather than blanket-everything.
--
-- consent_granted_at and consent_revoked_at form a soft lifecycle:
-- revocation stops new events from this account but does not delete
-- past events (per append-only / fix-forward rule). A revoked link
-- can be re-granted later (writes a new row, leaves the old one
-- archived for audit).
--
-- account_ref_external is the external system's identifier for the
-- account (Plaid item_id, MX guid, carrier account number, etc.).
-- Encrypted at rest in production via the same KMS path as
-- bank_accounts; v1 stores it plain because no external integrations
-- are live yet.
--
-- No backfill needed.

CREATE TABLE external_account_links (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id             UUID NOT NULL REFERENCES credit_subjects(id),
  category               TEXT NOT NULL CHECK (category IN (
    'utility',
    'telecom',
    'auto_loan',
    'insurance',
    'child_support',
    'medical',
    'subscription',
    'bank_account',
    'credit_card',
    'student_loan',
    'mortgage'
  )),
  provider               TEXT NOT NULL,
  provider_kind          TEXT NOT NULL CHECK (provider_kind IN (
    'plaid',
    'mx',
    'finicity',
    'carrier_direct',
    'lender_direct',
    'gam_bill_pay',
    'manual_upload'
  )),
  account_ref_external   TEXT NOT NULL,
  display_label          TEXT,
  consent_granted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consent_revoked_at     TIMESTAMPTZ,
  last_polled_at         TIMESTAMPTZ,
  last_event_emitted_at  TIMESTAMPTZ,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_external_account_links_subject  ON external_account_links (subject_id) WHERE consent_revoked_at IS NULL;
CREATE INDEX idx_external_account_links_category ON external_account_links (category);
CREATE INDEX idx_external_account_links_polled   ON external_account_links (last_polled_at) WHERE consent_revoked_at IS NULL;
