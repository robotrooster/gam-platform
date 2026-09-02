-- S631 (Nic, DIRECTIVE): "For onboarding existing tenants, I don't want it to
-- prorate the rent amount. If a landlord is proactively signing people up early,
-- like middle of the month, I don't want it to bill them. It should bill new
-- signups that move in at that point. But for the onboarding window and process,
-- it shouldn't prorate. They're counted as existing tenants."
--
-- Proration answers "how much of this month did you live here". For a NEW
-- move-in that is the right question. For a resident who has lived on the
-- property for years and is signing a GAM lease on the 29th, it is the wrong
-- one — nothing about their tenancy started that day, only the paperwork did.
-- Billing them 3/31ths of a month invents a charge that matches no arrangement
-- either party made, and billing them a FULL month on top of the one they
-- already paid the landlord off-platform would be worse.
--
-- So an existing tenancy signed mid-month is billed NOTHING for the remainder of
-- that month. Their first rent invoice is the next cycle, at full rent. The
-- month they signed in was settled off-platform, which is what
-- PRIOR_ARRANGEMENT_METHOD already exists to record if it needs recording.
--
-- Carried on the LEASE, not inferred at billing time, because it is a fact about
-- how the tenancy came to be: a lease papered during onboarding stays an
-- onboarded lease forever, and a report run next year must not have to
-- reconstruct it from dates.
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS is_existing_tenancy boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN leases.is_existing_tenancy IS
  'S631: this lease papers a tenancy that already existed when the landlord joined GAM, rather than a new move-in. Suppresses move-in rent proration — the first rent invoice is the next full cycle.';

ALTER TABLE pending_tenant_intents
  ADD COLUMN IF NOT EXISTS is_existing_tenancy boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pending_tenant_intents.is_existing_tenancy IS
  'S631: the landlord is papering an existing resident rather than inviting a new move-in. Copied onto the lease at signing.';

-- Every intent raised inside the landlord's onboarding migration window is an
-- existing tenancy by definition — that window exists precisely so a landlord
-- can paper the residents already living there. Backfilled for the ones already
-- outstanding, so tomorrow's signings behave correctly without anyone re-inviting.
UPDATE pending_tenant_intents pti
   SET is_existing_tenancy = true
  FROM landlords l
 WHERE l.id = pti.landlord_id
   AND pti.resolved_at IS NULL
   AND pti.cancelled_at IS NULL
   AND pti.created_at < l.created_at + (28 * INTERVAL '1 day');
