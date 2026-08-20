-- S607 (Nic, DIRECTIVE): tenant-scheduled autopay.
--
-- Nic: "if somebody has an ACH or debit on file, do they still have to manually
-- log in to pay, or do they have a way to set up autopay... if they're on fixed
-- income, say, set autopay to come out on the sixth or seventh, so we don't get
-- a failed ACH attempt."
--
-- There was NO autopay of any kind: every tenant logged in and pressed Pay Now
-- every month, and the only "autopay" references in the codebase describe a
-- landlord's PREVIOUS platform during migration reconciliation.
--
-- THE PULL DAY IS THE TENANT'S, AND ONLY THE TENANT'S.
--
-- Nic: "the landlord should not be pulling the strings on when the money gets
-- moved. That could be used the wrong way with a landlord pushing the date back
-- and getting extra late fees."
--
-- That abuse is the reason this is its own table keyed to the tenant rather than
-- a column on leases: the landlord's own record. Landlord-facing reads are
-- read-only by construction, and no landlord route writes here. A tenant paying
-- after the due date is still bound by the lease and still accrues whatever late
-- fee that lease specifies — the point is that they CHOOSE the date knowing the
-- cost, instead of an ACH failing into an overdraft they did not choose.
--
-- pull_day NULL means "on the due date", the ordinary case. 1..28 otherwise:
-- past 28 a day does not exist in February, and a schedule that silently skips a
-- month is worse than no schedule. Same bound FlexPay uses for the same reason.
--
-- projected_late_fee_cents is a SNAPSHOT taken when the tenant chose the day,
-- from that lease's own grace/initial/accrual/cap terms. Two purposes: it is
-- what the tenant was shown and agreed to, and it is the FlexPay qualification
-- signal — a tenant scheduling the 9th against a $50 projected fee is telling us
-- both when their money arrives and what lateness costs them. Never recomputed
-- in place; a new choice writes a new snapshot.
--
-- No state-specific logic: the projection is arithmetic over the landlord's own
-- configured late-fee fields. Notice periods and grace requirements differ by
-- state and are deliberately NOT encoded anywhere here.

CREATE TABLE IF NOT EXISTS tenant_autopay (
  id                       uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lease_id                 uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  enabled                  boolean NOT NULL DEFAULT TRUE,
  -- NULL = charge on the due date.
  pull_day                 integer,
  -- NULL = whatever the tenant's default payment method is at charge time, so a
  -- tenant who later switches from card to bank does not have to re-arm autopay.
  payment_method_id        text,
  projected_late_fee_cents integer,
  last_run_cycle           date,
  last_error               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_autopay_pull_day_check
    CHECK (pull_day IS NULL OR (pull_day >= 1 AND pull_day <= 28)),
  -- One arrangement per lease. A second would race itself and double-charge.
  CONSTRAINT tenant_autopay_one_per_lease UNIQUE (lease_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_autopay_enabled
  ON tenant_autopay (enabled, pull_day) WHERE enabled;

CREATE INDEX IF NOT EXISTS idx_tenant_autopay_tenant
  ON tenant_autopay (tenant_id);

COMMENT ON TABLE tenant_autopay IS
  'S607: tenant-scheduled rent autopay. The pull day is the TENANT''S choice and no landlord route may write to this table — a landlord able to move the date could manufacture late fees.';

COMMENT ON COLUMN tenant_autopay.pull_day IS
  'S607: day of month (1-28) the tenant chose, or NULL for the due date. Capped at 28 because 29-31 do not exist every month and a schedule that skips February is worse than none.';

COMMENT ON COLUMN tenant_autopay.projected_late_fee_cents IS
  'S607: what the chosen day was projected to cost in late fees when the tenant chose it, from that lease''s own terms. The figure the tenant agreed to, and the FlexPay qualification signal.';
