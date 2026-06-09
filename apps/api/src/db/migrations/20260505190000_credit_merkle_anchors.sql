-- Credit Ledger v1: Merkle anchors + landlords.network_tier.
--
-- Two concerns bundled because both are global integrity / membership
-- artifacts that don't warrant separate migration files.
--
-- ── credit_merkle_anchors ──────────────────────────────────
-- Periodic global integrity checkpoint. Weekly cron computes the Merkle
-- root over all (non-superseded) ledger events and records it here.
-- A row pins event_count + earliest/latest event ids so anyone can
-- reconstruct exactly which set was anchored.
--
-- external_attestation is reserved for v2.2 (third-party timestamp
-- service / blockchain anchor) — JSONB so the proof shape can vary by
-- service without schema churn.
--
-- ── landlords.network_tier ─────────────────────────────────
-- Network membership tier per the locked design. v1 only has
-- 'tier_2_full'; tier_1_network_only and tier_3_partner are reserved
-- enum values that don't appear in CHECK until they're actually
-- supported. (Adding them later is a schema change, but a small one.)
--
-- DEFAULT 'tier_2_full' applies to existing rows on column add — every
-- current landlord is tier_2_full at launch. NOT NULL is safe because
-- of the default.

CREATE TABLE credit_merkle_anchors (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merkle_root            BYTEA NOT NULL,
  event_count_at_anchor  BIGINT NOT NULL,
  earliest_event_id      UUID NOT NULL REFERENCES credit_events(id),
  latest_event_id        UUID NOT NULL REFERENCES credit_events(id),
  anchored_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  external_attestation   JSONB
);

CREATE INDEX idx_credit_merkle_anchored ON credit_merkle_anchors (anchored_at DESC);

ALTER TABLE landlords
  ADD COLUMN network_tier TEXT NOT NULL DEFAULT 'tier_2_full'
  CHECK (network_tier IN ('tier_2_full'));
