-- A resident can prefer a PAPER bill, hand delivered.  (10/26, Nic.)
--
--   "We get a lot of people that still are old school. Landlords that I talk to
--    still hand deliver bills to the tenants' doors on the first of each month,
--    especially where utilities are billed back and they don't exactly know
--    what their bill is going to be... During the onboarding process, I want to
--    add a way where it says this person prefers to receive a paper bill."
--
-- WHY THIS COLUMN LANDS NOW, AHEAD OF THE PRINTING ITSELF.  The printing (a
-- modal at bill-generation offering Print selection / Print all / Print none —
-- spec in PAPER_BILLS_SPEC.md) is the larger half and is not needed tomorrow.
-- The ASKING is time-critical: Nic has a landlord onboarding 25 units, and a
-- preference not captured during onboarding means going back to 25 people one
-- at a time. So the question gets a home before the printer does.
--
-- NULL means nobody has asked them, which is different from "no": it lets the
-- onboarding surfaces show the question rather than assuming an answer, and it
-- keeps "25 units onboarded before we started asking" visible instead of
-- silently reading as 25 refusals.
--
-- Per RESIDENT, not per property: two people in one park can want different
-- things, and the landlord-level "print them all anyway" override belongs on
-- the property when the printing is built.
--
-- No backfill: NULL for everyone is correct — nobody has been asked.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS prefers_paper_bill BOOLEAN,
  ADD COLUMN IF NOT EXISTS paper_bill_asked_at TIMESTAMPTZ;

COMMENT ON COLUMN tenants.prefers_paper_bill IS
  'Resident wants their bill on paper, hand delivered (10/26, Nic). NULL = never asked, which is NOT the same as no. Read by the bill-generation print queue (PAPER_BILLS_SPEC.md); never gates anything.';
COMMENT ON COLUMN tenants.paper_bill_asked_at IS
  'When the preference was last asked, so onboarding can tell "no" from "not asked yet".';

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS print_all_bills BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN properties.print_all_bills IS
  'Landlord prints every bill regardless of each resident''s preference (10/26, Nic: "maybe there''s a quick toggle for landlords that are just like, I''m going to print them all anyway").';
