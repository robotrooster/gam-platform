-- Credit Ledger v1: score formulas table + v1.0.0 seed.
--
-- Versioned formula definitions. Every credit_scores snapshot references
-- a version, so historical scores are reproducible. Formula rolls forward
-- via published_at + effective_from windows; v1.0.0 is initial.
--
-- The locked design (per credit-ledger session) is unbounded multiplicative:
--   - score starts at 0, floor at 0, no ceiling
--   - positive events = flat point additions
--   - negative events = percentage of CURRENT score (compounding)
--   - no decay, no recovery period; recovery = new positive events
--   - most severe event = -50% (eviction judgment, lease abandoned)
--   - confidence shown as event count, not interval
--   - dimensions are event TAGS for filtering, not separately scored
--   - score is internal-only (gated to GAM lending services)
--
-- definition JSONB shape:
--   {
--     "model": "unbounded_multiplicative_v1",
--     "starting_score": 0,
--     "floor": 0,
--     "positives": { "<event_type>": <points>, ... },
--     "negatives": { "<event_type>": <pct as 0..1>, ... },
--     "attestation_weight": { "<source>": <0..1>, ... },
--     "spam_caps": { "<event_type>": { "per": "year"|"month", "limit": N }, ... }
--   }
--
-- The score service (services/credit-score.ts, Session B) loads the
-- definition once and replays events for a subject. Replay is
-- deterministic; same chain → same score.
--
-- Self-reported events get attestation_weight 0 (informational only,
-- no score impact) per the locked anti-fraud rule. GAM-rail and partner
-- attested events get weight 1.0.
--
-- Forward-compat event types (utility_*, telecom_*, auto_loan_*,
-- insurance_*, child_support_*, medical_*, subscription_*, bill_pay_*)
-- have scoring values defined here so when v1.5+ integrations land,
-- scoring is already locked. They simply don't fire in v1.

CREATE TABLE credit_score_formulas (
  version         TEXT PRIMARY KEY,
  definition      JSONB NOT NULL,
  description     TEXT NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL,
  effective_to    TIMESTAMPTZ,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO credit_score_formulas (version, definition, description, effective_from)
VALUES (
  'v1.0.0',
  $JSON${
    "model": "unbounded_multiplicative_v1",
    "starting_score": 0,
    "floor": 0,

    "positives": {
      "payment_received_on_time":             100,
      "payment_received_late_grace":           30,
      "payment_received_late_minor":           10,
      "payment_received_late_major":            0,
      "payment_received_late_severe":           0,

      "lease_signed":                         250,
      "lease_renewed":                        500,
      "lease_terminated_natural":             500,
      "lease_anniversary":                    500,
      "proper_notice_given_for_move_out":     200,

      "move_in_inspection_completed":          50,
      "move_out_inspection_completed":         50,
      "move_out_condition_matches_move_in":   250,
      "move_in_photos_submitted":              50,
      "move_out_photos_submitted":             50,
      "deposit_returned_full":                250,
      "deposit_returned_within_state_window": 100,

      "renters_insurance_verified":           100,
      "utilities_transferred_at_move_in":       50,
      "unit_ready_on_move_in_date":            100,

      "maintenance_response_within_sla":        50,
      "maintenance_response_24h":              100,
      "maintenance_response_72h":               50,
      "maintenance_resolution_confirmed":      100,
      "repair_quality_held_30d":               100,
      "entry_request_granted_within_window":    50,
      "proper_entry_notice_given":              25,
      "lease_violation_cured":                  50,
      "balance_paid_post_move":                200,
      "rent_increase_with_proper_notice":       25,
      "multi_landlord_history_clean":          500,

      "utility_payment_on_time":                20,
      "utility_payment_late_grace":              5,
      "telecom_payment_on_time":                20,
      "auto_loan_payment_on_time":              50,
      "auto_loan_payment_late_grace":           20,
      "insurance_premium_on_time":              20,
      "child_support_paid_on_time":             50,
      "medical_payment_plan_on_time":           20,
      "subscription_payment_on_time":            5
    },

    "negatives": {
      "payment_received_late_minor":          0.03,
      "payment_received_late_major":          0.10,
      "payment_received_late_severe":         0.20,
      "payment_partial":                      0.10,
      "payment_failed_nsf":                   0.20,
      "payment_skipped":                      0.30,

      "noise_complaint_logged":               0.05,
      "lease_violation_notice_issued":        0.10,
      "property_damage_event_documented":     0.15,
      "nuisance_event_documented":            0.10,
      "entry_compliance_breach":              0.10,
      "maintenance_response_breach_sla":      0.05,
      "recurring_repair_same_issue":          0.15,
      "recurring_lease_violation":            0.25,

      "eviction_notice_filed":                0.20,
      "eviction_settled":                     0.25,
      "eviction_hearing_judgment_issued":     0.50,
      "lease_terminated_early_by_tenant":     0.10,
      "lease_abandoned":                      0.50,

      "tenancy_ended_with_balance":           0.30,
      "balance_sent_to_collections":          0.25,
      "utility_balance_unpaid_at_move_out":   0.10,

      "move_out_condition_damage_documented": 0.15,
      "deposit_returned_partial":             0.10,
      "deposit_returned_zero":                0.10,
      "deposit_returned_late":                0.10,
      "deposit_dispute_resolved_for_tenant":  0.20,
      "habitability_complaint_unresolved_30d":0.25,
      "rent_increase_without_proper_notice":  0.15,

      "utility_payment_late":                 0.03,
      "utility_disconnect_for_nonpayment":    0.20,
      "telecom_payment_missed":               0.10,
      "telecom_disconnect_for_nonpayment":    0.15,
      "auto_loan_payment_late":               0.08,
      "auto_loan_payment_missed":             0.15,
      "auto_loan_default":                    0.40,
      "insurance_lapsed_nonpayment":          0.15,
      "child_support_missed":                 0.25,
      "child_support_arrears":                0.40,
      "medical_collections_event":            0.10,
      "subscription_canceled_nonpayment":     0.02
    },

    "attestation_weight": {
      "gam_workflow_auto":                    1.0,
      "stripe_attested":                      1.0,
      "gam_bill_pay_attested":                1.0,
      "plaid_attested":                       1.0,
      "aggregator_attested":                  1.0,
      "carrier_attested":                     1.0,
      "lender_attested":                      1.0,
      "partner_cra":                          1.0,
      "court_record":                         1.0,
      "police_record":                        1.0,
      "medical_record_self_attested":         1.0,
      "landlord_self_reported_with_evidence": 1.0,
      "system_derived":                       1.0,
      "tenant_self_reported_with_doc_verified": 0.5,
      "tenant_self_reported":                 0.0
    },

    "spam_caps": {
      "maintenance_resolution_confirmed":     { "per": "year",  "limit": 12 },
      "lease_anniversary":                    { "per": "year",  "limit": 1 },
      "renters_insurance_verified":           { "per": "year",  "limit": 1 },
      "multi_landlord_history_clean":         { "per": "lifetime", "limit": 1 }
    }
  }$JSON$::jsonb,
  'v1.0.0 — unbounded multiplicative model. Positives are flat point additions; negatives are percentage-of-current-score (compounding). Most severe -50%. Floor at 0, no ceiling, no decay. Self-reported events 0× weight. Forward-compatible scoring values for utility/telecom/auto_loan/insurance/child_support/medical/subscription/bill_pay events present but un-emitted in v1; v1.5+ integrations begin firing them.',
  NOW()
);
