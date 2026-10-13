-- 10/12 (Nic) — A CARD READER'S MARKUP IS GAM EARNINGS; ITS COST IS NOT.
--
-- Nic: a reader's payments are "BOTH" the repayment of what the reader cost
-- GAM and "a slight markup" that is GAM's earnings — "book cost-recovery
-- separately from the markup". And (Q-g) "COST FIRST": the pieces repay GAM's
-- cost first; the markup lands in the last piece(s). Mountain View: 4 × $87.50
-- against a $331.73 cost → piece 4 carries $18.27 of markup.
--
-- GAM's earnings ledger (platform_revenue_ledger) had no type for it, so a
-- reader's money was nowhere in it. 'device_markup' is that type: one row per
-- installment piece that carries markup, booked when that piece is billed
-- (the way a platform fee is booked when it is billed), reference = the
-- landlord_gam_charges row of the piece ('reader_order_installment'). The cost
-- part of the payments is never booked as earnings; the GAM-money bridge shows
-- it on its own line (services/stripeCosts).
--
-- Same list plus one; mirrored by PLATFORM_REVENUE_TYPES in
-- packages/shared/src/money.ts (migrations.creditUses.test pins the two).
--
-- Expand-only: an allowed value added. Old code never writes it, so this is
-- safe to apply before the code ships. No backfill needed: no reader piece
-- carrying markup has been billed yet (production 10/12: Mountain View's piece
-- 1 of 4 is all cost; piece 4, the first with markup, is billed January 1).
-- Safe drop: put the constraint back without 'device_markup' once no row uses it.

SET LOCAL lock_timeout = '10s';

ALTER TABLE platform_revenue_ledger DROP CONSTRAINT IF EXISTS platform_revenue_ledger_type_check;
ALTER TABLE platform_revenue_ledger ADD CONSTRAINT platform_revenue_ledger_type_check
  CHECK (type IN ('banking_spread','manual_withdrawal_fee','placement_fee_share',
                  'platform_fee_subscription','screening_margin','adjustment',
                  'flexpay_subscription','device_markup'));
