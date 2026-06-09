-- S297: platform_claim_promotions — tracks which generic-upload
-- platform-name claims super admin has acknowledged for future
-- mapping work.
--
-- Lifecycle:
--   1. Generic uploads carry a free-text `claimed_platform_name`
--      (column already exists on csv_import_attempts from S295).
--      The S297 onboarding flow requires landlords to fill it.
--   2. The admin "claim candidates" view groups raw claims by
--      normalized name (lower + strip non-alphanumeric). When a
--      normalized name accumulates ≥ 5 distinct landlords, it
--      surfaces as a promotion candidate.
--   3. Super admin clicks "Promote" — inserts a row here. The
--      candidates query LEFT-JOINs against this table and filters
--      out promoted names so they don't keep nagging.
--   4. The actual mapping work (adding the platform to PLATFORMS
--      / mapping arrays / dropdown) happens in a code-change
--      session. Promotion is the signal, not the work.
--
-- Why a separate table rather than mutating csv_import_attempts:
--   - csv_import_attempts is an immutable audit trail of what was
--     uploaded when. Stamping a "promoted_at" on every matching
--     row would mutate audit history.
--   - Normalized name is the natural promotion key — one row here
--     covers all variant spellings ("DoorLoop", "doorloop",
--     "Door Loop" all map to the same normalized form).
--
-- Naming: `normalized_name` is the post-normalization claim string
-- (lowercase, alphanumerics only). The original raw claim variants
-- remain in csv_import_attempts.claimed_platform_name; this table
-- is the dedupe key.

CREATE TABLE platform_claim_promotions (
  normalized_name  text PRIMARY KEY,
  promoted_at      timestamptz NOT NULL DEFAULT now(),
  promoted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  notes            text,
  /* Snapshot of the most common raw spelling at promotion time —
     useful when reading back the promotion log without joining
     against the live attempts table. */
  example_raw_name text
);
