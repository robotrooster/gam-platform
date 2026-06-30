-- S513 — landlord-level "cover tenant ACH?" election (walkthrough follow-up #2).
--
-- WHY (Nic, S512 fee-payer lock): the tenant pays BOTH the ACH (1.0%/$6) and
-- card (3.25%) processing fees by DEFAULT. The landlord may elect, at
-- onboarding, to cover its tenants' ACH fees only — the landlord NEVER covers
-- card (card is always the tenant's). GAM absorbs neither.
--
-- The per-charge routing already lives per-property in
-- property_allocation_rules.ach_fee_payer / card_fee_payer (S114/S116). What was
-- missing is a LANDLORD-level default to capture the onboarding election, so that
-- (a) properties created/imported after onboarding inherit the choice, and
-- (b) the election can be re-applied across the whole portfolio when toggled.
-- card_fee_payer has no landlord default — it is hard-locked to 'tenant' in code.
--
-- Default 'tenant' = the launch default (tenant pays ACH). 'landlord' = the
-- landlord opted to cover ACH for its tenants.
--
-- No backfill needed: existing landlords get 'tenant' (matches the launch
-- default); their existing per-property ach_fee_payer rows are left as-is and
-- only change when the landlord makes/changes the election.

ALTER TABLE public.landlords
  ADD COLUMN default_ach_fee_payer text NOT NULL DEFAULT 'tenant';

ALTER TABLE public.landlords
  ADD CONSTRAINT landlords_default_ach_fee_payer_check
  CHECK (default_ach_fee_payer = ANY (ARRAY['landlord'::text, 'tenant'::text]));
