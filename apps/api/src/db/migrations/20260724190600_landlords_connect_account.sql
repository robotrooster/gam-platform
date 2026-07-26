-- Connect re-anchor, Stage 1 (S554) — give the LANDLORD ENTITY its own Stripe
-- Connect columns.
--
-- WHY: today a landlord's Connect account is keyed one-per-USER
-- (users.stripe_connect_account_id, S113). The multi-owner entity model
-- (landlord_members, S553) makes the ENTITY (landlords row = an LLC with its
-- own EIN/bank) the correct owner of the Connect account — each entity needs
-- its own KYC/account, and any founding/co-owner can complete it. This adds
-- the entity-level columns so stripeConnect.ts can resolve a landlord's
-- Connect account off the landlords row.
--
-- STAGE 1 IS ADDITIVE ONLY. No live caller is switched in this migration's
-- companion code — the 'landlord' ConnectEntity branch + webhook capability
-- sync are wired, but Banking/onboarding-session/destination-charge/
-- disbursement callers still use entity='user'. Switching them (Stage 2) is a
-- money-routing change done deliberately in a fresh pass, with live
-- membership re-checks on the money-critical routes (the dissolution-proofing
-- mitigation — a removed owner's stale JWT must not move an entity's funds).
--
-- Columns mirror the users/pm_companies Connect shape so the webhook
-- capability-sync and gating logic are identical across entity types.
-- Backfill: copy the founding/original owner's account onto the entity
-- (landlords.user_id is the original owner). Currently 0 rows carry an
-- account (no real KYC yet), so this backfill is a structural no-op today but
-- is correct for any account that already exists.

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id      text,
  ADD COLUMN IF NOT EXISTS stripe_connect_status_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS connect_charges_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_payouts_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_details_submitted      boolean NOT NULL DEFAULT false;

-- One entity ↔ one Stripe account (partial unique — NULLs allowed for
-- un-onboarded entities).
CREATE UNIQUE INDEX IF NOT EXISTS landlords_stripe_connect_account_id_uniq
  ON landlords (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

-- Backfill from the original owner's user row (no-op while 0 accounts exist).
UPDATE landlords la
   SET stripe_connect_account_id       = u.stripe_connect_account_id,
       stripe_connect_status_synced_at = u.stripe_connect_status_synced_at,
       connect_charges_enabled         = u.connect_charges_enabled,
       connect_payouts_enabled         = u.connect_payouts_enabled,
       connect_details_submitted       = u.connect_details_submitted
  FROM users u
 WHERE u.id = la.user_id
   AND u.stripe_connect_account_id IS NOT NULL
   AND la.stripe_connect_account_id IS NULL;
