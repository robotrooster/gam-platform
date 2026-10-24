-- 10/24 (Nic) — A REPLACEMENT LEASE NAMES THE LEASE IT REPLACES.
--
-- The handover built earlier today (services/spotSuccession) found the sitting
-- lease by INFERENCE: an active lease on the same space, a different household,
-- covering the day the new one starts. Nic caught what that means before it
-- shipped:
--
--   "we got to gate it, make sure it's invite only, so the landlord has to
--    proactively make a new lease for that spot when he has knowledge that the
--    other person's going to be leaving. It's not that somebody can just...
--    somebody else comes in, tries to book a reservation for 30 or more nights,
--    and it generates a draft lease automatically because and the background
--    check, because they're more than 30 nights, is that going to automatically
--    try to boot a person there?"
--
-- Inference cannot tell a deliberate handover from a lease that merely happens
-- to overlap, so ANY signed lease on an occupied space would have ended the
-- sitting resident's. (A booking cannot reach an occupied site — findStayConflict
-- refuses one over an active lease — but a lease drafted directly could.)
--
-- So the landlord says so, outright, by naming the lease being replaced. This
-- is the same shape as renews_lease_id, which is how a RENEWAL already names
-- the lease it follows; a replacement is the same fact about a different
-- household. Nothing automatic sets it: a booking draft, an application draft
-- and an ordinary new lease all leave it NULL, and a NULL hands over nothing.
--
-- NOT PAPERWORK. Blue will not have the two people associated on documents
-- ("not comfortable associating them together at all, even on paperwork"), and
-- this does not do that: it is a column one lease row carries about another,
-- printed on nothing, shown to no tenant, and naming no person. It exists so the
-- system is told which lease ends instead of guessing — which is what makes the
-- guessing, and the accidental boot it allows, impossible.
--
-- No backfill: every lease that exists today was made before replacements were
-- a thing, so NULL is correct for all of them.

ALTER TABLE lease_documents ADD COLUMN IF NOT EXISTS replaces_lease_id UUID REFERENCES leases(id) ON DELETE SET NULL;
COMMENT ON COLUMN lease_documents.replaces_lease_id IS
  '10/24: the sitting lease this new lease replaces on the same space. Set deliberately by the landlord when drafting; never by a booking or application draft. NULL = an ordinary new lease that ends nobody.';

ALTER TABLE leases ADD COLUMN IF NOT EXISTS replaces_lease_id UUID REFERENCES leases(id) ON DELETE SET NULL;
COMMENT ON COLUMN leases.replaces_lease_id IS
  '10/24: carried from the document at issuance. services/spotSuccession ends THIS lease the day before the new one starts, on the incoming resident''s signature and not before.';

-- A lease never replaces itself.
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_replaces_not_self;
ALTER TABLE leases ADD CONSTRAINT leases_replaces_not_self CHECK (replaces_lease_id IS NULL OR replaces_lease_id <> id);

-- One replacement per sitting lease. Two leases both claiming to replace the
-- same one is the "two signed replacements" conflict that no rule can settle —
-- refused here rather than resolved.
DROP INDEX IF EXISTS ux_leases_one_replacement_per_lease;
CREATE UNIQUE INDEX ux_leases_one_replacement_per_lease
  ON leases (replaces_lease_id)
  WHERE replaces_lease_id IS NOT NULL AND status IN ('pending', 'active');

CREATE INDEX IF NOT EXISTS idx_lease_documents_replaces ON lease_documents (replaces_lease_id) WHERE replaces_lease_id IS NOT NULL;
