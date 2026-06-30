-- S517 / Walkthrough #11 + booking-sites: subdomained per-property public
-- booking sites + waitlist.
--
-- WHY (Nic 2026-06-26): landlords who opt in get a public, GAM-subdomained
-- booking website for their property where the public books short-term
-- (nightly/weekly) stays, paying a DEPOSIT at booking via Stripe. When a
-- unit/date is full, guests join a waitlist; on a cancellation the next
-- waitlister gets a 1-hour claim link.
--
-- This mirrors the S507 business public-booking model (businesses
-- .public_booking_slug/_enabled + routes/publicBooking.ts) but for property
-- units + dated stays. The subdomain itself is a frontend/DNS concern — the
-- API resolves a property by its slug regardless of how the slug arrives
-- (subdomain in prod, path in dev).
--
-- Stage 1 of 5: schema only. Endpoints + Stripe deposit + waitlist logic +
-- frontends land in later stages.

-- ── Property: public booking-site config ─────────────────────
-- Mirrors the businesses slug/enabled pattern + format CHECK (lowercase
-- a–z/0–9, single hyphens, 2–61 chars, no leading hyphen, no '--').
ALTER TABLE properties
  ADD COLUMN public_booking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN booking_slug text,
  ADD COLUMN booking_intro text,
  -- Deposit charged at booking, as a percent of the stay total. Landlord-set
  -- per property; the public booking endpoint computes the Stripe deposit
  -- from this. 0 is allowed (no deposit) but enabled sites default to 25%.
  ADD COLUMN booking_deposit_pct numeric(5,2) NOT NULL DEFAULT 25.00,
  ADD CONSTRAINT properties_booking_deposit_pct_range
    CHECK (booking_deposit_pct >= 0 AND booking_deposit_pct <= 100),
  ADD CONSTRAINT properties_public_booking_enabled_needs_slug
    CHECK (public_booking_enabled = false OR booking_slug IS NOT NULL),
  ADD CONSTRAINT properties_booking_slug_format
    CHECK (booking_slug IS NULL
           OR (booking_slug ~ '^[a-z0-9][a-z0-9-]{1,60}$' AND booking_slug !~ '--'));

-- Slug is the public identifier; must be globally unique when set.
CREATE UNIQUE INDEX ux_properties_booking_slug
  ON properties (booking_slug) WHERE booking_slug IS NOT NULL;

-- ── unit_bookings: deposit-at-booking fields ─────────────────
-- A public booking starts 'tentative' and holds the dates only until
-- hold_expires_at; once the Stripe deposit settles it flips to 'confirmed'
-- with deposit_paid_at stamped. The hold-expiry lets the overlap check
-- ignore abandoned unpaid holds so they don't block the calendar forever.
ALTER TABLE unit_bookings
  ADD COLUMN deposit_amount numeric(10,2),
  ADD COLUMN deposit_paid_at timestamp with time zone,
  ADD COLUMN stripe_checkout_session_id text,
  ADD COLUMN hold_expires_at timestamp with time zone;

CREATE UNIQUE INDEX ux_unit_bookings_checkout_session
  ON unit_bookings (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;

-- ── Waitlist ─────────────────────────────────────────────────
-- One row per guest waiting on a full unit/date. On a cancellation the
-- earliest 'waiting' row for an overlapping range is promoted to 'notified'
-- with a 1-hour claim_token; if unclaimed by claim_expires_at it rolls to
-- 'expired' and the next is promoted. A successful claim links the new
-- booking via claimed_booking_id.
CREATE TABLE unit_booking_waitlists (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    unit_id            uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    landlord_id        uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,

    guest_name         text NOT NULL,
    guest_email        text NOT NULL,
    guest_phone        text,
    check_in           date NOT NULL,
    check_out          date NOT NULL,

    status             text NOT NULL DEFAULT 'waiting',
    claim_token        text,
    notified_at        timestamp with time zone,
    claim_expires_at   timestamp with time zone,
    claimed_booking_id uuid REFERENCES unit_bookings(id) ON DELETE SET NULL,

    created_at         timestamp with time zone NOT NULL DEFAULT now(),
    updated_at         timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT unit_booking_waitlists_status_check
      CHECK (status = ANY (ARRAY['waiting','notified','claimed','expired','cancelled'])),
    CONSTRAINT unit_booking_waitlists_dates_check
      CHECK (check_out > check_in)
);

-- Promotion query walks waiting rows for a unit by FIFO within an overlapping range.
CREATE INDEX idx_unit_booking_waitlists_unit_status
  ON unit_booking_waitlists (unit_id, status, created_at);
-- Claim landing resolves a row by its token.
CREATE UNIQUE INDEX ux_unit_booking_waitlists_claim_token
  ON unit_booking_waitlists (claim_token) WHERE claim_token IS NOT NULL;
