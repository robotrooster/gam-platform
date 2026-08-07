-- S580: instant-withdrawal money-flow rebuild — collect GAM's margin by NETTING
-- against the next disbursement (never pre-pulled), + a circuit breaker to
-- isolate a flaky instant-payout path. No manual admin recovery, ever.
--
-- WHY (Nic): the old instant-withdrawal flow pulled GAM's margin off the
-- landlord's Connect balance BEFORE firing the payout, then REVERSED that pull
-- if the payout failed. If the payout AND the reversal both failed (rare but
-- real at scale), the landlord was charged-for-nothing until an admin manually
-- fixed it. GAM's income is secured UPSTREAM (platform fee at charge time), so
-- the instant margin must never create a stuck state.
--
-- NEW MODEL:
--   * Fire the instant payout for the landlord's NET (available − all-in fee).
--     GAM never pre-pulls its margin, so there is nothing to reverse.
--   * Record GAM's margin as an `owed` receivable here. The weekly batch
--     collects it Connect→platform (idempotent) BEFORE sweeping the balance to
--     the landlord's bank — i.e. it nets against the next disbursement. If the
--     balance can't cover it (landlord withdrew everything), it stays `owed` and
--     collects from a future influx. GAM's margin is small; it can never strand
--     the landlord.
--   * A per-Connect-account circuit breaker: consecutive instant failures trip
--     `disabled`, and instant requests then fall back to the free standard
--     payout automatically — isolating the bad path + preventing recurrence,
--     with the landlord still getting paid.
--
-- No backfill: new tables; no existing instant margins/circuit state.

CREATE TABLE public.landlord_instant_margins (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id            uuid REFERENCES public.landlords(id),   -- null for opt-in-manager (user-account) withdrawals
  connect_account_id     text NOT NULL,                          -- the account the margin is collected FROM
  amount                 numeric(12,2) NOT NULL,
  status                 text NOT NULL DEFAULT 'owed'
    CHECK (status = ANY (ARRAY['owed'::text, 'collected'::text])),
  source_disbursement_id uuid REFERENCES public.disbursements(id),
  stripe_transfer_id     text,
  attempts               integer NOT NULL DEFAULT 0,
  last_error             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  collected_at           timestamptz
);
CREATE INDEX idx_instant_margins_owed
  ON public.landlord_instant_margins (connect_account_id)
  WHERE status = 'owed';

CREATE TABLE public.connect_instant_circuit (
  connect_account_id   text PRIMARY KEY,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled             boolean NOT NULL DEFAULT false,
  last_error           text,
  last_failure_at      timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
