-- S542b: FlexPay FCFS queue + state holds (Nic).
--
-- Rollout is FIRST COME, FIRST SERVE by inquiry time — created_at on
-- flexpay_inquiries IS the queue order (no new column needed; position
-- is computed). The ONLY thing that holds someone back is a state-level
-- legal block: if a state requirement prevents offering FlexPay there,
-- tenants in that state stay ON the waitlist (keep their place, show a
-- hold) until the state clears. Everyone else moves through in order.
--
-- flexpay_blocked_states starts EMPTY — no state has been identified.
-- This is the MECHANISM only (consistent with the S177 posture: encode
-- a state rule when one is actually identified, superadmin-managed).
-- Approval of a held tenant is refused at the API until the state row
-- is removed.
--
-- No backfill needed.

CREATE TABLE flexpay_blocked_states (
  state      text PRIMARY KEY CHECK (length(state) = 2),
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
