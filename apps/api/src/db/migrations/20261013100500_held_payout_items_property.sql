-- 10/12 (Nic) — EVERY HELD PAYOUT LINE NAMES ITS PROPERTY
--
-- held_payout_items is what GAM holds for a landlord outside rent (a register
-- card sale, a booking deposit, a refund or a chargeback netted, a GAM fee, a
-- move-out settlement) and pays in the Tuesday payout. The table had no
-- property: a landlord with three parks got one undivided list, and the ledger
-- — which keeps every line on its property and balances each property on its
-- own (gam-ledger-design-2026-10-12 §9) — could not tell which park's books a
-- line belongs to (§P1, M2).
--
-- property_id is written by every writer when it writes the line
-- (heldPayouts.recordHeldItem and the three direct INSERTs in allocation,
-- depositReturn and depositRefundSend), from the thing the line is about: the
-- sale's property, the booking's site, the disputed payment's space, the
-- lease's space. NULL means the line is company-level: a business's line
-- (businesses have no properties), or one charge's fee that paid rows at more
-- than one of a landlord's properties.
--
-- Properties are permanent (never deleted), so the foreign key never blocks.
-- Backfill needed: lines written before today get their property from their
-- source (scripts/oct12_ledger_source_facts_backfill.ts, named in
-- ledger_derived_facts). Production 10/12: 5 lines, all register card sales.
-- Safe drop: ALTER TABLE held_payout_items DROP COLUMN property_id.

ALTER TABLE held_payout_items ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id);

CREATE INDEX IF NOT EXISTS held_payout_items_property_idx
  ON held_payout_items (property_id) WHERE property_id IS NOT NULL;

COMMENT ON COLUMN held_payout_items.property_id IS
  '10/12 (Nic, ledger P1): the property this payout line belongs to, written by its writer. NULL: company-level (a business''s line, or a charge''s fee spanning properties).';
