-- S561 (money-flow platform-holds, Phase 3): link a reopened rent row back to
-- the payment_reversal that spawned it.
--
-- WHY: when a post-settlement reversal reopens a tenant's rent (a fresh
-- 'pending' rent row), and the tenant later re-pays it via the FIFO pay-balance
-- route, the settle path must (a) resolve that reversal and (b) route the money
-- correctly — re-disburse to the landlord if GAM already clawed the rent back
-- from them, or KEEP it (reimbursing GAM's reversal loss) if the landlord was
-- never disturbed. This nullable column carries that link; only reopened rows
-- set it. No backfill needed.

ALTER TABLE public.payments ADD COLUMN reversal_id uuid;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_reversal_id_fkey
  FOREIGN KEY (reversal_id) REFERENCES public.payment_reversals(id);

CREATE INDEX idx_payments_reversal_id
  ON public.payments (reversal_id) WHERE reversal_id IS NOT NULL;
