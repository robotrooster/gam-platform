-- Home-sale plan type (S594, Nic — support flat recurring plans).
--
-- WHY: a landlord selling a park-owned MH/RV to a tenant on payments shouldn't
-- be forced to express the deal as an interest-bearing amortization. Nic wants
-- to ALSO support a plain "recurring invoice that ends after N payments" — a
-- flat $X/month × N. Functionally a flat plan is amortization at 0% interest
-- (each installment = the flat amount), so the existing billing + payoff
-- pipeline is reused unchanged; this column only records which shape the
-- landlord chose so the UI can display + edit it correctly.
--
-- SAFE: additive with a default; every existing contract is 'amortized'
-- (its historical behavior). No backfill needed.

ALTER TABLE public.home_sale_contracts
  ADD COLUMN IF NOT EXISTS plan_type text NOT NULL DEFAULT 'amortized';

ALTER TABLE public.home_sale_contracts
  DROP CONSTRAINT IF EXISTS home_sale_contracts_plan_type_check;
ALTER TABLE public.home_sale_contracts
  ADD CONSTRAINT home_sale_contracts_plan_type_check
  CHECK (plan_type = ANY (ARRAY['amortized'::text, 'flat'::text]));

COMMENT ON COLUMN public.home_sale_contracts.plan_type IS
  'S594: amortized (price+interest+term) or flat ($X × N, no interest). Flat is stored as 0% amortization so downstream billing/payoff is identical.';
