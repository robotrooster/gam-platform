-- S642 (Nic): "You say 21 states are custody blocked, but I thought when we
-- were searching through in a different session that 45 to 47 states was okay
-- for us to hold security deposits on behalf of the landlord, whether it's in a
-- for-benefit-of account, FBO account through Column or something like that."
--
-- He remembered right, and 'blocked' was hiding three completely different
-- obstacles behind one word. All 21 were researched 2026-08-14, BEFORE the
-- custody vehicle was settled — so 'blocked' has meant "we have not confirmed
-- our vehicle satisfies this", not "this is impossible". The code fail-closes
-- on anything that is not 'supported', so those deposits go to landlords and
-- GAM loses both the custody and the spread on states it could probably serve.
--
-- Splitting the reason so the FBO account's real reach is legible:
--
--   vehicle_unconfirmed (8) — DE GA ID IL MO ND PA TN. The statute asks for a
--     federally insured / federally regulated institution and nothing more. An
--     FBO at a chartered bank is exactly that. Idaho's own text describes GAM's
--     posture outright: "Deposits held by a THIRD-PARTY AGENT must sit in a
--     separate account at a federally insured financial institution, kept apart
--     from the agent's operating funds." Missouri's note says it plainly — "the
--     vehicle is the only obstacle."
--
--   in_state_depository (9) — CT FL MA MI NC NH NY OK WA. The money must sit in
--     a bank IN THAT STATE. One national FBO account does not solve these; it
--     takes an in-state banking relationship or a partner with one.
--
--   pooling_restricted (4) — AK CO KY ME. The hard ones, and the ones that go
--     to the heart of a POOLED trust. Alaska bars using one tenant's trust money
--     for another's refund; Colorado forbids commingling trust funds "with other
--     money"; Maine bars commingling with the assets of "any other entity or
--     person"; Kentucky requires the tenant be told the account's location and
--     number, implying an identifiable account per tenant. A single pooled FBO
--     may not satisfy these at all — per-tenant sub-accounts might.
--
-- NOTHING IS RECLASSIFIED HERE. Flipping a state to 'supported' sends real
-- tenant money into GAM's custody on a legal reading, and that is Nic's call
-- with counsel once Column's structure is actually standing — not something to
-- infer from a notes field. This only makes the distinction visible so nobody
-- mistakes "unconfirmed" for "impossible".
ALTER TABLE state_deposit_custody_rules
  ADD COLUMN IF NOT EXISTS blocked_reason text
    CHECK (blocked_reason IS NULL OR blocked_reason IN
      ('vehicle_unconfirmed','in_state_depository','pooling_restricted','other'));

COMMENT ON COLUMN state_deposit_custody_rules.blocked_reason IS
  'Why custody_status is blocked. vehicle_unconfirmed = a federally insured FBO would likely satisfy it; in_state_depository = needs a bank in that state; pooling_restricted = a single pooled trust may not be permitted at all. NULL when not blocked.';

UPDATE state_deposit_custody_rules SET blocked_reason = 'vehicle_unconfirmed'
 WHERE custody_status = 'blocked' AND state_code IN ('DE','GA','ID','IL','MO','ND','PA','TN');

UPDATE state_deposit_custody_rules SET blocked_reason = 'in_state_depository'
 WHERE custody_status = 'blocked' AND state_code IN ('CT','FL','MA','MI','NC','NH','NY','OK','WA');

UPDATE state_deposit_custody_rules SET blocked_reason = 'pooling_restricted'
 WHERE custody_status = 'blocked' AND state_code IN ('AK','CO','KY','ME');

UPDATE state_deposit_custody_rules SET blocked_reason = 'other'
 WHERE custody_status = 'blocked' AND blocked_reason IS NULL;

-- MA's flags said "federally insured, no in-state requirement" while its own
-- note says "a separate interest-bearing account in a MASSACHUSETTS bank". The
-- note was right; the flag was wrong, and it is the flag a query would trust.
UPDATE state_deposit_custody_rules
   SET requires_in_state_depository = TRUE
 WHERE state_code = 'MA';
