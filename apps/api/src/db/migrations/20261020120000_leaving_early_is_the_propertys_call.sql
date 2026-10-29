-- 10/18 (Nic) — WHAT HAPPENS WHEN SOMEBODY LEAVES EARLY IS THE PROPERTY'S CALL
--
--   "refunds are pro rated to the next price down. people pay for a week they
--    stay 4 days. the 4 day rate against the weekly rate is the difference for
--    the refund IF THE LANDLORD DOES REFUNDS AT ALL AT THAT PROPERTY. the only
--    way it is different is for longer term people for rent pro ration. moving
--    in or out at the middle of a month and also only if the landlord allows
--    the pro rate. THESE SHOULD ALL BE PROPERTY LEVEL SETTINGS."
--
-- Two questions a landlord answers for each property, and neither had anywhere
-- to live. Until today every property on GAM gave money back and prorated,
-- because that is all the code could do — there was no column to say otherwise.
-- rent_due_mode says WHEN rent is due and nothing about either of these.
--
-- 1. early_departure_refunds — do you give money back when someone leaves
--    early? Off: the price as booked stands. The check-out window stops
--    offering a refund and says so plainly instead of handing the desk choices
--    the park does not honor, and rent a resident paid past the day they left
--    stays on their account as money paid ahead rather than going back out.
--    Nothing else about the check-out changes: the guest is still checked out,
--    the lease still ends on the day they left, and the final bill is still
--    made. Nor does it touch what a guest who has NOT paid yet is charged —
--    "charge only the nights stayed" is pricing, not a refund.
--
-- 2. prorates_mid_month_rent — do you prorate rent when a long-term resident
--    moves in or out mid-month? Off: a whole month is a whole month, BOTH
--    WAYS — the month they move into is billed whole (page 8's rent line, and
--    the move-in invoice behind it) and the month they move out of is owed
--    whole. On (the default) the days are counted against the ACTUAL days in
--    that month, the one proration GAM has (moveInCharges prorateMoveInRent),
--    never a flat 30 — and the last days of a long stay whose guest leaves
--    part-way into another month are a prorated share of that month rather
--    than weeks and nights off the price ladder (stayPricing
--    priceNightsStayed).
--
-- WHY BOTH DEFAULT TRUE — and the two are NOT the same story.
--
--   early_departure_refunds TRUE is exactly what the live properties do today.
--   There was no column, so there was no way to refuse a refund, and Nic
--   checked two guests out today expecting money back. Defaulting it to false
--   would refuse a refund somebody was promised, at every property at once, on
--   the day this ships.
--
--   prorates_mid_month_rent TRUE is what the live properties do today for a
--   MOVE-IN (prorateMoveInRent has run on every property since the start;
--   rent_due_mode is 'fixed_day' everywhere), and it is NEW for a long-stay
--   guest's last days. Before today those days were re-rated down the ladder
--   as weeks and nights. Defaulting it to TRUE ships Nic's 10/18 correction
--   ("I want that prorated amount to be divided by the 30 days or whatever ...
--   not calculated off the weekly rate. Because I don't want to do that to
--   people that are, you know, long-term good customers") to all seven live
--   properties with no landlord action, DELIBERATELY: the same stay that
--   offered $17.00 back yesterday offers $314.13 now. That is the point of the
--   change. Defaulting it to FALSE would instead leave the correction switched
--   off everywhere and silently bill a sitting resident a whole month for a
--   mid-month move-in. Either answer only ever gives a guest MORE back, never
--   less, and never charges anyone more than they would pay today.
--
-- The landlord turns either one off when their park works that way, and whether
-- a BRAND NEW property should start somewhere else is Nic's call, not a column
-- default's.
--
-- Expand only, and no backfill: the DEFAULT supplies every existing row, which
-- is the behavior those rows already have, so there is nothing to correct.
-- Idempotent (ADD COLUMN IF NOT EXISTS), so a re-run is a no-op.
--
-- properties already carries the change journal (audit_properties), so both
-- answers record who changed them and what they said before.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS early_departure_refunds boolean DEFAULT true NOT NULL,
  ADD COLUMN IF NOT EXISTS prorates_mid_month_rent boolean DEFAULT true NOT NULL;

COMMENT ON COLUMN public.properties.early_departure_refunds IS
  '10/18 (Nic): does this property give money back when someone leaves early? "the difference for the refund if the landlord does refunds at all at that property." FALSE = the price as booked stands: the check-out window offers no refund and says so, and rent paid past the day they left stays on the resident''s account as money paid ahead. Never gates checking the guest out, ending their lease, or what an unpaid stay is charged. Default TRUE = what every property did before this column existed.';
COMMENT ON COLUMN public.properties.prorates_mid_month_rent IS
  '10/18 (Nic): does this property prorate rent when a long-term resident moves in or out mid-month? "only if the landlord allows the pro rate." FALSE = a whole month is a whole month both ways: the month moved into is billed whole on page 8 and the move-in invoice, and the month moved out of is owed whole. TRUE = the days are counted against the ACTUAL days in that month, via the one proration GAM has (shared moveInCharges prorateMoveInRent) — never a flat 30. Also governs the prorated tail of a long stay whose guest leaves part-way into another month (shared stayPricing priceNightsStayed), which is NEW on 10/18 and arrives switched on at every property by this default, deliberately; move-in proration is what every property already did.';
