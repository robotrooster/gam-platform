-- S646 — THE MANAGER DOES NOT GET TO PICK THE OWNER'S PAYDAY.
--
-- Nic (S646, DIRECTIVE): "I don't know if we should choose when — like if we're
-- holding the money, why would the property manager choose when the owner gets
-- paid? It's our schedule as the payment processor and provider. Yeah, there
-- seems like there's some friction there."
--
-- There was, and it was mine. I carried `payout_mode` over from a design where
-- 'pm_trust' meant the MANAGER held the funds in their own broker account. Nic
-- then settled custody the other way — GAM's books hold everything until
-- disbursement, the same as for any landlord, because keeping money moving
-- between Stripe balances beats re-debiting an account that has gone short
-- after an ACH reversal.
--
-- Once custody is GAM's, the two modes describe the same event. 'direct' and
-- 'pm_trust' both mean: GAM holds, GAM pays the owner on GAM's cadence, net of
-- the manager's fee. A toggle whose two settings do the same thing is worse
-- than no toggle — someone eventually believes it.
--
-- And the schedule itself is not a manager's to set. GAM is the processor; the
-- payout run is GAM's (jobs/autoPayouts.ts — weekly, plus the month-end sweep).
-- Letting a manager move an owner's payday would have made GAM's own settlement
-- calendar negotiable by a third party who is not holding the money.
--
-- Empty in production; nothing that happened is erased.
ALTER TABLE pm_owner_relationships
  DROP COLUMN IF EXISTS payout_mode,
  DROP COLUMN IF EXISTS disbursement_day;

DROP INDEX IF EXISTS idx_pm_owner_rel_trust_day;
