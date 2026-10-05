-- 10/4 (decisions #46.1a, review fix choice46b pass 2): MONEY PAID AHEAD
-- LEFT AS THE TENANT'S CREDIT KEEPS WHERE IT ARRIVED, AND MOVES ONLY ONTO A
-- LEASE THE PERSON HAS SIGNED.
--
-- 20261004490000 made "Leave it as their credit" keep the money the tenant's:
-- the credit is marked (left_by_choice_id) and paid_ahead_carry_left moves it
-- onto the person's next lease with the same landlord by rewriting
-- lease_prepaid_credits.lease_id. Two problems the review found:
--
--   1. Every reader of WHERE money arrived keys on lease_id (Money received's
--      paid-ahead arrival line, the owner statement's money paid ahead to the
--      manager). The next lease can be at another property — under a property
--      manager, another owner's — so the carry moved the arrival out of the
--      old property's past months and the old owner's closed statement, and
--      into the new one's past. §0.0: "Money received" is the day money
--      arrived, where it arrived, and a past month is never rewritten.
--      → received_lease_id: the lease the money arrived on, set ONCE by the
--        carry (COALESCE: a second carry keeps the first lease). NULL means
--        it never moved: lease_id is where it arrived. The arrival readers
--        read COALESCE(received_lease_id, lease_id); carrying the credit only
--        changes which lease's bills it pays.
--   2. The carry ran for a 'pending_add' membership (an addendum not signed
--      yet): the person's money moved onto a lease they had not signed, and
--      stayed on another household's lease if the addendum was voided —
--      against "nobody is attached without their own signature".
--      → carried only for an 'active' membership: the move happens when the
--        addendum executes (lease_tenants.status → 'active'), in the function
--        and in trg_paid_ahead_carry_left_member's WHEN clause.
--
-- Expand-only: one nullable column (no backfill needed — NULL reads as "never
-- moved", which is true of every existing row: the carry has never run in
-- production, 20261004490000 is not applied yet), the function replaced, one
-- trigger re-created with a narrower WHEN. Safe drop: the column (readers
-- fall back to lease_id).

ALTER TABLE lease_prepaid_credits ADD COLUMN IF NOT EXISTS received_lease_id uuid REFERENCES leases(id);
COMMENT ON COLUMN lease_prepaid_credits.received_lease_id IS
  '10/4 (decisions #46.1a): the lease this money paid ahead ARRIVED on, set once when paid_ahead_carry_left moves money left as the tenant''s credit to their next lease with the landlord. NULL: it never moved (lease_id is where it arrived). Readers of where money arrived (Money received''s paid-ahead line, the owner statement) read COALESCE(received_lease_id, lease_id), so a carry never rewrites a past month or another property''s report.';

CREATE OR REPLACE FUNCTION paid_ahead_carry_left(p_lease uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  -- Money paid ahead the landlord left as the tenant's credit when an earlier
  -- lease ended follows that person to this lease of the same landlord, once
  -- this lease is in force and they are ON it with their own signature
  -- (membership 'active' — never a pending addendum). It becomes this lease's
  -- money paid ahead (the mark is cleared); who holds it (funded_by) never
  -- changes, and where it arrived (received_lease_id) is kept.
  UPDATE lease_prepaid_credits c
     SET received_lease_id = COALESCE(c.received_lease_id, c.lease_id),
         lease_id = p_lease, left_by_choice_id = NULL, updated_at = now()
    FROM leases nl, leases ol
   WHERE nl.id = p_lease AND nl.status = 'active'
     AND c.left_by_choice_id IS NOT NULL AND c.voided_at IS NULL
     AND ol.id = c.lease_id AND ol.id <> nl.id AND ol.landlord_id = nl.landlord_id
     AND EXISTS (SELECT 1 FROM lease_tenants lt
                  WHERE lt.lease_id = nl.id AND lt.tenant_id = c.tenant_id
                    AND lt.status = 'active');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
COMMENT ON FUNCTION paid_ahead_carry_left(uuid) IS
  '10/4 (decisions #46.1a): move money paid ahead left as a tenant''s credit (lease_prepaid_credits.left_by_choice_id) onto this lease of the same landlord when it is in force and they are an active (signed) member of it. Keeps where it arrived (received_lease_id). Returns how many credits moved.';

DROP TRIGGER IF EXISTS trg_paid_ahead_carry_left_member ON lease_tenants;
CREATE TRIGGER trg_paid_ahead_carry_left_member AFTER INSERT OR UPDATE OF status ON lease_tenants
  FOR EACH ROW WHEN (NEW.status = 'active') EXECUTE FUNCTION paid_ahead_carry_left_on_member();
