-- S580: durable transfer-intent state machine for platform→landlord Connect
-- passthrough (the fire-after-commit money-movement foundation).
--
-- WHY: reconcilePlatformHeldPayments fired the platform→Connect Stripe Transfer
-- INSIDE its DB transaction, with no idempotency key. If the Transfer succeeded
-- but the commit failed, platform_held stayed true → the automatic retry (next
-- account.updated webhook / weekly cron) re-summed the same owner-share and
-- fired ANOTHER Transfer → the landlord was PAID TWICE (GAM eats it). The
-- codebase already knew the right pattern (firePmTransfersForReference: "fire
-- AFTER the DB transaction commits"); this table lets the passthrough do the
-- same, durably and retry-safely, at scale.
--
-- The flow becomes: RESERVE (txn: claim the owner-share, net reversals, write a
-- pending intent, flip platform_held, stamp the ledger with an intent sentinel)
-- → EXECUTE (outside txn: fire the Transfer with a deterministic idempotency key
-- derived from the intent id) → CONFIRM (txn: stamp the real transfer id). A
-- RECOVER pass re-fires any stuck 'pending' intent with the SAME idempotency key
-- → Stripe dedupes an already-sent Transfer, or completes one that never fired.
-- No double-pay, no stranded money.
--
-- No backfill: new table; existing already-settled passthroughs are unaffected
-- (their owner-share rows already carry a real stripe_transfer_id).

CREATE TABLE public.platform_transfer_intents (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id                    uuid NOT NULL REFERENCES public.landlords(id),
  landlord_user_id               uuid NOT NULL REFERENCES public.users(id),
  destination_connect_account_id text NOT NULL,
  amount                         numeric(12,2) NOT NULL,          -- net to transfer (gross_owed - netted_amount)
  gross_owed                     numeric(12,2) NOT NULL,          -- total owner-share reserved by this intent
  netted_amount                  numeric(12,2) NOT NULL DEFAULT 0,
  payments_settled               integer       NOT NULL DEFAULT 0,
  status                         text NOT NULL DEFAULT 'pending'
    CHECK (status = ANY (ARRAY['pending'::text, 'transferred'::text, 'failed'::text])),
  stripe_transfer_id             text,
  attempts                       integer NOT NULL DEFAULT 0,
  last_error                     text,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  transferred_at                 timestamptz
);

-- Recovery scans pending intents oldest-first.
CREATE INDEX idx_platform_transfer_intents_pending
  ON public.platform_transfer_intents (created_at)
  WHERE status = 'pending';
