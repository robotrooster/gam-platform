-- 10/4 (decisions #46.1a — the orchestrator's default, following GAM's existing
-- paid-ahead rule; told to Nic, who may change it): "LEAVE IT AS THEIR CREDIT"
-- KEEPS THE MONEY THE TENANT'S.
--
-- Before this, "Leave it as their credit" on the paid-ahead money screen
-- (services/paidAheadChoice) released money GAM held to the landlord at once
-- and wrote an ordinary landlord-issued tenant credit (category 'other') that
-- the landlord could void — so "still the tenant's money" could silently turn
-- into "Keep it", and a credit report would read it as a credit the landlord
-- GAVE (never income, "Credits given" under Money billed) when it is money the
-- tenant PAID.
--
-- Now the money simply stays what it is — the tenant's money paid ahead
-- (lease_prepaid_credits), with nothing spent at the decision:
--   * money GAM holds (it came through Stripe) stays GAM-held and is released
--     to the landlord only when it pays one of the tenant's bills — the same
--     rule paid-ahead money already follows (allocation pays out its
--     gam_held_part on the day it pays a bill);
--   * money the landlord holds (cash, check, money order, a bank deposit) is
--     credit the landlord owes the tenant, used on their next bill;
--   * neither is a landlord-issued credit, so nothing on the landlord's side
--     can void it.
-- It FOLLOWS THE PERSON to their next lease with this landlord: the credit is
-- marked left by the choice (left_by_choice_id) and, when that person is on a
-- lease of the same landlord that is in force (a lease becoming active, or the
-- person joining one that is), it moves onto that lease — exactly as the
-- renewal hand-off moves paid-ahead money (scheduler.handOffOpenItemsToRenewal)
-- — and becomes that lease's ordinary money paid ahead (the mark is cleared,
-- so if that lease ends with money left, the landlord is asked again).
--
--   1. lease_prepaid_credits.left_by_choice_id — the choice that left this
--      credit as the tenant's (NULL: an ordinary credit). The paid-ahead
--      screen and its to-do skip marked credits (decided once).
--   2. paid_ahead_choices.left_gam_held — of rest_amount left as their credit,
--      what GAM holds (said back on the decided card: "GAM keeps holding $X").
--      paid_ahead_choices_credit_shape (a credit choice must name tenant
--      credits) is dropped: a credit choice now writes none.
--   3. paid_ahead_carry_left(lease) + two AFTER triggers (a lease becoming
--      active; a person becoming a member of a lease) move marked credits of
--      that lease's people, from another lease of the same landlord, onto it.
--
-- Expand-only: two nullable/defaulted columns, one CHECK dropped (relaxed),
-- one CHECK every existing row passes (left_gam_held defaults 0), one function
-- and two triggers that touch only credits carrying the new mark — which only
-- the new code writes. No backfill needed. Safe drop: the column, the
-- function and the triggers.

ALTER TABLE lease_prepaid_credits ADD COLUMN IF NOT EXISTS left_by_choice_id uuid REFERENCES paid_ahead_choices(id);
CREATE INDEX IF NOT EXISTS idx_lease_prepaid_credits_left ON lease_prepaid_credits (tenant_id) WHERE left_by_choice_id IS NOT NULL;
COMMENT ON COLUMN lease_prepaid_credits.left_by_choice_id IS
  '10/4 (decisions #46.1a): the paid-ahead choice that left this money as the tenant''s ("Leave it as their credit") on an ended lease. It stays their money paid ahead (GAM-held money is released to the landlord only when it pays a bill) and moves to their next lease with this landlord (paid_ahead_carry_left), which clears the mark. NULL: an ordinary credit.';

ALTER TABLE paid_ahead_choices ADD COLUMN IF NOT EXISTS left_gam_held numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE paid_ahead_choices DROP CONSTRAINT IF EXISTS paid_ahead_choices_credit_shape;
ALTER TABLE paid_ahead_choices DROP CONSTRAINT IF EXISTS paid_ahead_choices_left_shape;
ALTER TABLE paid_ahead_choices ADD CONSTRAINT paid_ahead_choices_left_shape
  CHECK (left_gam_held >= 0 AND left_gam_held <= rest_amount AND (rest_choice = 'credit' OR left_gam_held = 0));
COMMENT ON COLUMN paid_ahead_choices.left_gam_held IS
  '10/4 (decisions #46.1a): of rest_amount left as the tenant''s credit, what GAM holds (it stays GAM-held until it pays one of their bills). 0 for Keep it.';

CREATE OR REPLACE FUNCTION paid_ahead_carry_left(p_lease uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  -- Money paid ahead the landlord left as the tenant's credit when an earlier
  -- lease ended follows that person to this lease of the same landlord, once
  -- this lease is in force and they are on it. It becomes this lease's money
  -- paid ahead (the mark is cleared); who holds it (funded_by) never changes.
  UPDATE lease_prepaid_credits c
     SET lease_id = p_lease, left_by_choice_id = NULL, updated_at = now()
    FROM leases nl, leases ol
   WHERE nl.id = p_lease AND nl.status = 'active'
     AND c.left_by_choice_id IS NOT NULL AND c.voided_at IS NULL
     AND ol.id = c.lease_id AND ol.id <> nl.id AND ol.landlord_id = nl.landlord_id
     AND EXISTS (SELECT 1 FROM lease_tenants lt
                  WHERE lt.lease_id = nl.id AND lt.tenant_id = c.tenant_id
                    AND lt.status IN ('active', 'pending_add'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
COMMENT ON FUNCTION paid_ahead_carry_left(uuid) IS
  '10/4 (decisions #46.1a): move money paid ahead left as a tenant''s credit (lease_prepaid_credits.left_by_choice_id) onto this lease of the same landlord when it is in force and they are on it. Returns how many credits moved.';

CREATE OR REPLACE FUNCTION paid_ahead_carry_left_on_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM paid_ahead_carry_left(NEW.id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_paid_ahead_carry_left_lease ON leases;
CREATE TRIGGER trg_paid_ahead_carry_left_lease AFTER INSERT OR UPDATE OF status ON leases
  FOR EACH ROW WHEN (NEW.status = 'active') EXECUTE FUNCTION paid_ahead_carry_left_on_lease();

CREATE OR REPLACE FUNCTION paid_ahead_carry_left_on_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM paid_ahead_carry_left(NEW.lease_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_paid_ahead_carry_left_member ON lease_tenants;
CREATE TRIGGER trg_paid_ahead_carry_left_member AFTER INSERT OR UPDATE OF status ON lease_tenants
  FOR EACH ROW WHEN (NEW.status IN ('active', 'pending_add')) EXECUTE FUNCTION paid_ahead_carry_left_on_member();

COMMENT ON TABLE paid_ahead_choices IS
  '10/4 (decisions #46.1, #46.1a): the landlord''s choice for paid-ahead money left on an ended lease — No refund / Refund all of it / Refund a different amount, and for the rest Keep it (released to the landlord when GAM held it: released_amount, prepaid_draw held items) or Leave it as their credit (nothing spent: the credits stay the tenant''s money paid ahead, marked lease_prepaid_credits.left_by_choice_id, and follow them to their next lease with this landlord; left_gam_held = what GAM keeps holding). tenant_credit_ids is only on choices made before #46.1a. Written by services/paidAheadChoice.ts only.';
