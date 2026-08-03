-- S565: nightly nexus revenue tally (the computed side of the nexus monitor).
--
-- services/nexusMonitor.ts recomputes this table nightly: GAM's OWN revenue,
-- attributed by CUSTOMER state, per calendar year (current + prior — the window
-- most states' "prior or current calendar year" rule needs). The admin nexus
-- dashboard reads this joined against state_nexus_thresholds + registrations.
--
-- What counts (Nic's S564 decision — count conservatively, register EARLY):
--   • platform fee (platform_fee_accruals)          → by property state
--   • screening sales (screening_fee_accruals)       → by applicant state (gross)
--   • business platform fee (business_platform_fee_accruals) → by business state
--   • FlexPay fees (flexpay_advances.tenant_fee_amount)      → by unit/property state
--   (FlexDeposit/FlexCharge fees are future sources — flag-off today, add when live.)
--
-- What is EXCLUDED (not GAM's own revenue):
--   • rent (landlord's lease — pass-through)
--   • landlord/business POS sales (their sale; GAM is a POS provider, not a
--     marketplace facilitator — revisit only if GAM builds a true multi-seller
--     marketplace, which pulls MPF rules in)
--   • payouts (money movement)
--   • monthly_fee_accruals (legacy platform-fee table, superseded by
--     platform_fee_accruals — excluded to avoid double-counting the same fee)
--
-- The tally is a MONITORING trigger only. It never collects tax. Collection is
-- gated on state_tax_registrations (S565 tax migration). Recompute is a full
-- overwrite per (state, year); no history kept here (git + the accrual tables
-- are the audit trail).

CREATE TABLE nexus_revenue_tally (
  state_code    text    NOT NULL,
  period_year   integer NOT NULL,
  revenue_usd   numeric(14,2) NOT NULL DEFAULT 0,
  txn_count     integer NOT NULL DEFAULT 0,
  computed_at   timestamp with time zone NOT NULL DEFAULT NOW(),
  PRIMARY KEY (state_code, period_year),
  CONSTRAINT nrt_state_check
    CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT nrt_year_check
    CHECK (period_year BETWEEN 2020 AND 2100),
  CONSTRAINT nrt_revenue_check
    CHECK (revenue_usd >= 0)
);

COMMENT ON TABLE nexus_revenue_tally IS
  'Nightly-recomputed GAM own-revenue by customer state + calendar year (S565). Feeds the admin nexus dashboard; compared against state_nexus_thresholds. Monitoring only — never collects tax.';
