-- S648 (Nic): the onboarding late-fee waiver is the LANDLORD'S choice, not a
-- platform rule.
--
--   "The way the late fees need to be blocked at tenant onboarding is only if
--    the landlord opts into that. We need to make that part of the flow. 'Are
--    you going to waive any late fees during this onboarding process as people
--    migrate?' Most landlords might say no, but we want them to have the
--    option. The tenants need to be billed late fees if the landlord doesn't
--    agree to waive them. I did that for myself personally here but not every
--    landlord's going to do that."
--
-- S639/S640/S647 exempted every existing resident's FIRST platform invoice from
-- late fees, unconditionally, in three places (the monthly generator, the
-- move-in invoice, and the late-fee engine itself). That was Nic's decision for
-- his own parks leaking into everyone's. The rule stays exactly as shaped — it
-- follows the person (is_existing_tenancy), first invoice only — but now only
-- runs where the landlord said yes.
--
-- Per property, because onboarding happens per property (the onboarding window
-- is a property fact) and a landlord bringing a second park on later may answer
-- differently.
--
-- NULL = not answered yet = NO waiver: residents are billed late fees under
-- their lease terms. Only an explicit TRUE waives.
--
-- Backfill: Oak Park Motel and RV and Mountain View RV Ranch = TRUE (Nic's own
-- answer, already in force). Every other property: NULL. No other property has
-- an existing-tenancy lease today, so nothing else changes behaviour.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS onboarding_late_fee_waiver boolean;

COMMENT ON COLUMN properties.onboarding_late_fee_waiver IS
  'S648: landlord''s answer to "waive late fees on each existing resident''s first bill while they migrate?". TRUE = that first invoice never accrues late fees. FALSE or NULL (unanswered) = late fees apply per the lease.';

UPDATE properties SET onboarding_late_fee_waiver = TRUE
 WHERE id IN ('f63a3b3c-f673-480d-bc90-6d9bd3b0b818',
              'dcccb7b8-7ac9-4ec2-b3ff-40bde536df01');
