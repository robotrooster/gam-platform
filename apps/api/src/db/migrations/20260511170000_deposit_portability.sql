-- S255: FlexDeposit portability — when a tenant moves between GAM
-- landlords, the deposit carries forward to the new lease instead
-- of triggering the standard deposit-return engine.
--
-- Product decisions confirmed S255 (Nic):
-- Q1 (detection): auto-detect when tenant has another GAM lease in
--    pending/active status, with explicit tenant opt-out at termination
-- Q2 (money model): push for GAM-escrow holding wherever possible.
--    held_by='gam_escrow' deposits: zero-money-movement re-point.
--    held_by='landlord' deposits: admin-mediated transfer of funds from
--    landlord's Connect → GAM platform balance (Stripe Connect reverse-
--    Transfer is the underlying mechanism but for S255 we tag the row
--    pending admin action and defer the live API call to follow-up
--    admin tooling — most deposits going forward should be gam_escrow
--    so landlord-held portability is the legacy edge case).
-- Q3 (authorization): explicit tenant signature at termination flow.
--    Mirrors S250 sublease liability disclosure pattern — generic copy
--    + signature input + audit fields.
--
-- ── Columns ───────────────────────────────────────────────────────
-- portability_status: state machine for the carry-forward decision
--   none              — no portability in play (default)
--   pending_auth      — tenant has eligible new lease; waiting on
--                       authorization signature at termination time
--   authorized        — tenant signed; ready to execute (engine
--                       branch on lease-end picks this up)
--   carried_forward   — execution complete; this deposit row has
--                       been re-pointed to a new lease
--   pending_transfer  — landlord-held deposit awaiting admin move
--                       from landlord Connect → GAM escrow
--   declined          — tenant opted out; standard deposit-return flow
-- portability_authorized_at  — timestamp of tenant signature
-- portability_authorized_signature — text capture of the signature
--                                    (mirror existing e-sign style;
--                                    image upload deferred)
-- portability_authorized_ip — IP at signature time for audit
-- portability_target_lease_id — the next lease this deposit should
--                              transfer to
-- carried_from_deposit_id — when a deposit is the result of a carry-
--                          forward, this points back at the source
--                          security_deposits row for audit-trail
--                          continuity

ALTER TABLE security_deposits
  ADD COLUMN portability_status text NOT NULL DEFAULT 'none',
  ADD COLUMN portability_authorized_at        timestamptz,
  ADD COLUMN portability_authorized_signature text,
  ADD COLUMN portability_authorized_ip        text,
  ADD COLUMN portability_target_lease_id      uuid REFERENCES leases(id),
  ADD COLUMN carried_from_deposit_id          uuid REFERENCES security_deposits(id);

ALTER TABLE security_deposits
  ADD CONSTRAINT security_deposits_portability_status_check
    CHECK (portability_status = ANY (ARRAY[
      'none',
      'pending_auth',
      'authorized',
      'carried_forward',
      'pending_transfer',
      'declined'
    ]));

CREATE INDEX idx_security_deposits_portability_pending
  ON security_deposits (portability_status)
  WHERE portability_status IN ('pending_auth', 'authorized', 'pending_transfer');

CREATE INDEX idx_security_deposits_carried_from
  ON security_deposits (carried_from_deposit_id)
  WHERE carried_from_deposit_id IS NOT NULL;
