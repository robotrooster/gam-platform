-- S245: FlexPay product schema.
--
-- FlexPay is a tenant-paid payment-scheduling service. The tenant picks
-- their preferred rent pull day (1-28) and pays a $5 + day-of-month fee
-- ($6 to $33 range). In exchange, GAM fronts the rent to the landlord
-- on the lease's grace-period-end day so the landlord isn't waiting on
-- the tenant. The fee is the price of the scheduling-and-fronting
-- service — it is NOT a loan, NOT credit insurance, NOT a credit advance.
-- Copy and identifiers throughout the codebase reflect that framing.
--
-- Day cap = 28 chosen to cover SSDI / Social Security retirement
-- recipients whose payment day depends on birth date — the latest
-- payment day is the 4th Wednesday of the month, which can fall as
-- late as the 28th. SSI / VA / Civil Service / military retirement
-- pay on the 1st and are covered by any pull day ≥ 1.
--
-- ── Money-flow ─────────────────────────────────────────────────────
-- Day grace_end (lease.late_fee_grace_days, default 5):
--   GAM fires stripe.transfers.create from platform balance to
--   landlord's Connect account for the full rent amount. EXCEPT
--   when OTP already advanced this cycle — then suppress this
--   leg (`grace_advance_suppressed = TRUE`). The advance row still
--   exists for audit; the Transfer just doesn't fire because the
--   landlord is already covered.
-- Day pull_day (tenant's chosen 1-28):
--   GAM initiates two ACH pulls from tenant's verified bank:
--   (1) the rent amount — reimburses GAM's advance (or the OTP
--       advance when both are active);
--   (2) the FlexPay fee ($5 + pull_day) — GAM revenue for the
--       service.
-- Reconciliation:
--   When BOTH tenant pulls settle, advance row → status='reconciled'.
--   NSF on the rent pull → existing ACH retry (NACHA 2 retries max),
--   after exhaustion → status='defaulted', tenant disqualified for
--   60 days (mirrors OTP NSF posture).
--
-- ── OTP interaction ────────────────────────────────────────────────
-- FlexPay and OTP coexist freely. From the tenant's POV nothing
-- changes — they pay the FlexPay fee and the rent on their chosen
-- day. From the landlord's POV nothing changes — they receive the
-- earlier of the two advances (OTP fires EOM, FlexPay fires
-- grace-period-end). GAM collects both fees (1% from landlord via
-- OTP + $5+day from tenant via FlexPay) when both flags are on.
-- The dedup is one-sided: the SECOND of the two landlord-advance
-- legs is suppressed to prevent double-paying the landlord. Since
-- OTP fires first (EOM < grace-end), it always wins the front.

-- ── Tenant flag columns ────────────────────────────────────────────

ALTER TABLE tenants
  ADD COLUMN flexpay_enrolled            boolean      DEFAULT false NOT NULL,
  ADD COLUMN flexpay_pull_day            integer,
  ADD COLUMN flexpay_monthly_fee         numeric(5,2),
  ADD COLUMN flexpay_enrolled_at         timestamptz,
  ADD COLUMN flexpay_disqualified_until  timestamptz,
  ADD COLUMN flexpay_disqualified_reason text;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_flexpay_pull_day_check
    CHECK (flexpay_pull_day IS NULL OR (flexpay_pull_day >= 1 AND flexpay_pull_day <= 28));

-- ── flexpay_advances ───────────────────────────────────────────────
-- One row per (tenant, cycle_month). Mirrors the otp_advances shape
-- so admin tooling + reconciliation patterns translate cleanly.

CREATE TABLE flexpay_advances (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  cycle_month              date NOT NULL,
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  landlord_id              uuid NOT NULL REFERENCES landlords(id),
  unit_id                  uuid NOT NULL REFERENCES units(id),
  lease_id                 uuid NOT NULL REFERENCES leases(id),

  -- ── Rent + fee amounts ─────────────────────────────────────────
  rent_amount              numeric(10,2) NOT NULL,
  tenant_fee_amount        numeric(10,2) NOT NULL,  -- $5 + pull_day
  pull_day                 integer NOT NULL,        -- 1..28

  -- ── Grace-period-end advance (GAM → landlord) ──────────────────
  -- Suppressed when OTP already fronted this cycle; otherwise fires
  -- a Stripe Connect Transfer from platform balance to landlord.
  grace_advance_suppressed boolean NOT NULL DEFAULT false,
  stripe_transfer_id       text,                    -- null when suppressed or pending
  transfer_attempted_at    timestamptz,
  transfer_error           text,
  fronted_at               timestamptz,

  -- ── Tenant ACH pulls (initiated on pull_day) ───────────────────
  rent_payment_id          uuid REFERENCES payments(id),
  fee_payment_id           uuid REFERENCES payments(id),
  pulled_at                timestamptz,             -- both pulls initiated
  reconciled_at            timestamptz,             -- both pulls settled
  defaulted_at             timestamptz,
  default_reason           text,

  status                   text NOT NULL DEFAULT 'pending',

  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT NOW(),
  updated_at               timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT flexpay_advances_pull_day_check
    CHECK (pull_day >= 1 AND pull_day <= 28),
  CONSTRAINT flexpay_advances_status_check
    CHECK (status = ANY (ARRAY['pending', 'fronted', 'pulled', 'reconciled', 'nsf', 'defaulted'])),
  CONSTRAINT flexpay_advances_amount_positive
    CHECK (rent_amount > 0 AND tenant_fee_amount > 0),
  CONSTRAINT flexpay_advances_cycle_tenant_uniq
    UNIQUE (cycle_month, tenant_id)
);

CREATE INDEX idx_flexpay_advances_landlord  ON flexpay_advances (landlord_id, cycle_month DESC);
CREATE INDEX idx_flexpay_advances_tenant    ON flexpay_advances (tenant_id, cycle_month DESC);
CREATE INDEX idx_flexpay_advances_status    ON flexpay_advances (status);
CREATE INDEX idx_flexpay_advances_pull_day  ON flexpay_advances (pull_day) WHERE status IN ('pending', 'fronted');

CREATE UNIQUE INDEX idx_flexpay_advances_stripe_transfer_id
  ON flexpay_advances (stripe_transfer_id) WHERE stripe_transfer_id IS NOT NULL;
