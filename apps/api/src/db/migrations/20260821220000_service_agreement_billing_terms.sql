-- S615: a service agreement's own billing terms.
--
-- WHEN IT BILLS. A lease says rent_due_day; an agreement had nothing, so there
-- was no answer to "what date is the trash bill due". Defaults to the 1st,
-- which is what every Oak Park lease uses.
--
-- LATE FEES (Nic, S615 — asked directly: an unpaid utility bill takes "the same
-- late fee as rent"). The parameters are STAMPED ON THE AGREEMENT at creation
-- from the property's policy rather than read live, for exactly the reason
-- S558 stamps them on a lease: the instrument is the charge. A landlord who
-- changes property policy in March must not silently reprice a bill someone
-- already agreed to — that has to go through a superseding agreement, not a
-- settings tweak. Same columns, same CHECK values, same shared math.
--
-- ON 'percent_of_rent' UNDER AN AGREEMENT THAT HAS NO RENT: the type name is
-- kept so the enum, the shared calculators and the landlord's late-fee screens
-- stay one thing rather than two. The BASIS is passed in by the caller, and for
-- a service invoice it is the invoice's own billable charges — the utilities,
-- which are the entire obligation. Basing it on a rent that structurally cannot
-- exist would silently compute every such fee as $0.

ALTER TABLE utility_service_agreements
  ADD COLUMN IF NOT EXISTS billing_due_day integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS late_fee_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS late_fee_grace_days integer,
  ADD COLUMN IF NOT EXISTS late_fee_initial_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS late_fee_initial_type text NOT NULL DEFAULT 'flat',
  ADD COLUMN IF NOT EXISTS late_fee_accrual_amount numeric,
  ADD COLUMN IF NOT EXISTS late_fee_accrual_type text,
  ADD COLUMN IF NOT EXISTS late_fee_accrual_period text,
  ADD COLUMN IF NOT EXISTS late_fee_accrual_from text NOT NULL DEFAULT 'grace_end',
  ADD COLUMN IF NOT EXISTS late_fee_cap_amount numeric,
  ADD COLUMN IF NOT EXISTS late_fee_cap_type text;

ALTER TABLE utility_service_agreements
  DROP CONSTRAINT IF EXISTS usa_billing_due_day_check;
ALTER TABLE utility_service_agreements
  ADD CONSTRAINT usa_billing_due_day_check
  CHECK (billing_due_day BETWEEN 1 AND 31);

-- Same value sets as leases + properties. Restated here rather than referenced
-- so a future reader sees what is legal without chasing three tables.
ALTER TABLE utility_service_agreements DROP CONSTRAINT IF EXISTS usa_late_fee_initial_type_check;
ALTER TABLE utility_service_agreements ADD CONSTRAINT usa_late_fee_initial_type_check
  CHECK (late_fee_initial_type IN ('flat','percent_of_rent'));
ALTER TABLE utility_service_agreements DROP CONSTRAINT IF EXISTS usa_late_fee_accrual_type_check;
ALTER TABLE utility_service_agreements ADD CONSTRAINT usa_late_fee_accrual_type_check
  CHECK (late_fee_accrual_type IS NULL OR late_fee_accrual_type IN ('flat','percent_of_rent'));
ALTER TABLE utility_service_agreements DROP CONSTRAINT IF EXISTS usa_late_fee_accrual_period_check;
ALTER TABLE utility_service_agreements ADD CONSTRAINT usa_late_fee_accrual_period_check
  CHECK (late_fee_accrual_period IS NULL OR late_fee_accrual_period IN ('daily','weekly','monthly'));
ALTER TABLE utility_service_agreements DROP CONSTRAINT IF EXISTS usa_late_fee_accrual_from_check;
ALTER TABLE utility_service_agreements ADD CONSTRAINT usa_late_fee_accrual_from_check
  CHECK (late_fee_accrual_from IN ('grace_end','due_date','due_date_inclusive'));
ALTER TABLE utility_service_agreements DROP CONSTRAINT IF EXISTS usa_late_fee_cap_type_check;
ALTER TABLE utility_service_agreements ADD CONSTRAINT usa_late_fee_cap_type_check
  CHECK (late_fee_cap_type IS NULL OR late_fee_cap_type IN ('flat','percent_of_rent'));

COMMENT ON COLUMN utility_service_agreements.billing_due_day IS
  'S615: day of month this agreement''s utility invoice is due. Clamped to the '
  'last day in shorter months, same as a lease''s rent_due_day.';
COMMENT ON COLUMN utility_service_agreements.late_fee_initial_amount IS
  'S615: stamped from property policy when the agreement is created. NULL means '
  'no late fee was configured at the property, and none accrues.';
