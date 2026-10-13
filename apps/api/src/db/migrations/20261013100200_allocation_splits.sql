-- 10/12 (Nic) — EACH OWNER-SHARE SPLIT IS STORED AS IT WAS MADE
--
-- When a landlord's charge row settles with money GAM holds for them,
-- services/allocation.executeRentAllocation splits that money: the
-- landlord-paid processing fee comes off first, then supersedence and sublease
-- markup, then the PM company's cut, then the manager's fee, and the owner
-- gets the rest. Only the RESULTS were kept (user_balance_ledger rows for the
-- owner, manager and PM company). The fee withheld was computed and thrown
-- away, and when the cuts were more than GAM held for the landlord the shortfall
-- went only into an admin notice. A ledger rebuilt later could not say what was
-- withheld, what was paid, or what nobody covered (gam-ledger-design-2026-10-12
-- §P1, M2; allocation.ts "Short → cap, clamp, tell an admin").
--
-- allocation_splits is that split, written by executeRentAllocation in the same
-- transaction as the owner share it explains. One row per allocation (a payment
-- is allocated once; the owner-share rows are the idempotency guard):
--   gross_held               what GAM held for the landlord on the row (v_payment_money.gam_held_part)
--   landlord_fee_withheld    the landlord-paid processing fee taken from it
--   landlord_fee_uncovered   the part of that fee GAM held too little to take
--   supersedence, sublease_markup   the row's own amounts, which left at charge time
--   pm_fee_due / pm_paid     the PM company's cut, and what was paid of it
--   manager_fee_due / manager_paid  the manager's fee, and what was paid of it
--   short_by                 everything due that GAM held too little to pay
--   owner_share              what the owner was booked
-- They always add up: gross_held = landlord_fee_withheld + supersedence +
-- sublease_markup + pm_fee_due + manager_fee_due + owner_share − short_by.
-- remittance_id: the receipt whose Stripe charge paid the row (NULL when credit
-- or the desk paid it); credit_use_id: the one GAM-held credit spend that paid
-- it (NULL when none, or more than one).
--
-- Append-only: a split is never changed or removed (a trigger refuses UPDATE
-- and DELETE; TRUNCATE is left for the test harness). No foreign keys, on
-- purpose: a stored fact must outlive the row it explains (the ledger reverses
-- a deleted source), and nothing here may ever stop a tenant's payment from
-- settling — so no CHECKs either; the identity above is held by the writer and
-- its tests.
--
-- Backfill needed: owner shares booked before this table existed get a split
-- worked out from what is on record (scripts/oct12_ledger_source_facts_backfill.ts),
-- named in ledger_derived_facts (column '*'). Production 10/12: 95 owner
-- shares, landlord fee withheld $0 on every one.
-- Safe drop: DROP TABLE allocation_splits (and DROP FUNCTION
-- allocation_splits_append_only).

CREATE TABLE IF NOT EXISTS allocation_splits (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id              uuid NOT NULL,
  landlord_id             uuid NOT NULL,
  property_id             uuid NOT NULL,
  remittance_id           uuid,
  credit_use_id           uuid,
  gross_held              numeric(12,2) NOT NULL,
  landlord_fee_withheld   numeric(12,2) NOT NULL DEFAULT 0,
  landlord_fee_uncovered  numeric(12,2) NOT NULL DEFAULT 0,
  supersedence            numeric(12,2) NOT NULL DEFAULT 0,
  sublease_markup         numeric(12,2) NOT NULL DEFAULT 0,
  pm_fee_due              numeric(12,2) NOT NULL DEFAULT 0,
  pm_paid                 numeric(12,2) NOT NULL DEFAULT 0,
  manager_fee_due         numeric(12,2) NOT NULL DEFAULT 0,
  manager_paid            numeric(12,2) NOT NULL DEFAULT 0,
  short_by                numeric(12,2) NOT NULL DEFAULT 0,
  owner_share             numeric(12,2) NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS allocation_splits_payment_idx ON allocation_splits (payment_id);
CREATE INDEX IF NOT EXISTS allocation_splits_landlord_idx ON allocation_splits (landlord_id, created_at);

COMMENT ON TABLE allocation_splits IS
  '10/12 (Nic, ledger P1): how executeRentAllocation split the money GAM held for the landlord on one settled row — fee withheld/uncovered, cuts due and paid, short_by, owner share. Append-only.';

CREATE OR REPLACE FUNCTION allocation_splits_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'allocation_splits is a record of how money was split when it settled; it is never changed or removed (%).', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS allocation_splits_append_only ON allocation_splits;
CREATE TRIGGER allocation_splits_append_only
  BEFORE UPDATE OR DELETE ON allocation_splits
  FOR EACH ROW EXECUTE FUNCTION allocation_splits_append_only();
