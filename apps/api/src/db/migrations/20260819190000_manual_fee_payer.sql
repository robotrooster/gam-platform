-- S607 (Nic, DIRECTIVE): a fourth fee toggle — who covers the manual-payment fee.
--
-- Nic: "we need a toggle for them to cover old-fashioned payment costs if they
-- want to. If they aren't covering it, it's still charged out of their collect
-- account, but the tenant gets invoiced. So the landlord isn't out any money.
-- We need to have that upfront when they are onboarding the property, that way
-- the landlord isn't surprised."
--
-- Sits alongside ach_fee_payer / card_fee_payer / platform_fee_payer (S116)
-- rather than in a new table: it is the same question about a different rail,
-- the landlord answers all four in one place during onboarding, and the
-- allocation engine already reads this row on every payment.
--
-- WHAT THE TOGGLE ACTUALLY CHANGES — and what it does not:
--
--   The $10 is GAM revenue either way, and it is always recovered from the
--   landlord's collections (a type='fee' row is never disbursed). The toggle
--   decides ONLY whether the TENANT is invoiced to reimburse it.
--
--     'tenant'   (DEFAULT) — the tenant is billed $10, the landlord is made
--                whole, nobody is out of pocket but the tenant.
--     'landlord' — no tenant charge is raised; the landlord absorbs it. Chosen
--                deliberately, or because local law requires the landlord to
--                bear the cost of accepting a lawful payment method.
--
-- DEFAULT IS 'tenant' — this is a cost-recovery fee, and a landlord who has not
-- opted in has not agreed to absorb anything. It also matches ach_fee_payer /
-- card_fee_payer, which default to the tenant for the same reason.
--
-- Backfill: every existing rule gets 'tenant', reproducing today's behaviour
-- exactly (the fee has always been billed to the tenant).
--
-- NO STATE-SPECIFIC LOGIC. Some jurisdictions restrict charging a tenant for
-- paying by a lawful method; GAM does not decide which. The toggle exists so a
-- landlord can comply where they must, and the tenant-facing copy says the
-- landlord may stop covering it at any time.

ALTER TABLE property_allocation_rules
  ADD COLUMN IF NOT EXISTS manual_fee_payer text NOT NULL DEFAULT 'tenant';

ALTER TABLE property_allocation_rules
  DROP CONSTRAINT IF EXISTS property_allocation_rules_manual_fee_payer_check;
ALTER TABLE property_allocation_rules
  ADD CONSTRAINT property_allocation_rules_manual_fee_payer_check
  CHECK (manual_fee_payer = ANY (ARRAY['landlord'::text, 'tenant'::text]));

COMMENT ON COLUMN property_allocation_rules.manual_fee_payer IS
  'S607: who reimburses the $10 cash/check/money-order fee. tenant (default) = the tenant is invoiced for it. landlord = the landlord absorbs it and no tenant charge is raised. GAM recovers the fee from the landlord''s collections either way; this only decides whether the tenant is billed to make them whole.';
