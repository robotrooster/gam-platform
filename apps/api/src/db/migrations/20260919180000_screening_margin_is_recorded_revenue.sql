-- S650 (Nic): "Where is that $5 from that first background check?"
--
-- It was in GAM's Stripe balance and nowhere else. The applicant pays Checkr's
-- cost + GAM's $5 + tax + card processing, and since S636 that charge settles
-- 100% to the platform — no landlord split, no application fee. But nothing
-- ever wrote the $5 into GAM's revenue ledger, so every earnings figure either
-- missed it or estimated it by counting checks. Cash with no record.
--
-- 'screening_margin' joins the ledger's own types so the $5 is recorded the
-- moment the applicant pays, the same way a card spread or a platform fee is.
ALTER TABLE platform_revenue_ledger DROP CONSTRAINT platform_revenue_ledger_type_check;
ALTER TABLE platform_revenue_ledger ADD CONSTRAINT platform_revenue_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'banking_spread', 'manual_withdrawal_fee', 'placement_fee_share',
    'platform_fee_subscription', 'screening_margin', 'adjustment']));
