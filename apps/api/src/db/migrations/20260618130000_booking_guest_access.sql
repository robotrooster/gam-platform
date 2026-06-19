-- Booking-guest identity + light-action records (agent guest track).
--
-- A no-account booking guest (RV/STR/extended-stay stay in unit_bookings)
-- needs a way to identify themselves to the guest agent WITHOUT a GAM
-- account. Mechanism: a per-booking access token, minted at booking
-- creation, delivered by email-link or on-site QR (no SMS, per product
-- decision). Unlike single-use payment tokens, this token is REUSABLE for
-- the duration of the stay — the guest chats with the agent repeatedly —
-- and expires at checkout + a buffer. Revocable by the host.
--
-- The guest agent is read + light-action: it can RECORD a stay-change
-- request (late checkout, extra night, etc.) for the host to approve. It
-- never commits the change — booking_change_requests is the durable,
-- append-only record the host finalizes.
--
-- Also widens the agent_interaction_logs.audience CHECK to admit 'guest'
-- so guest conversations log alongside tenant/landlord/prospect.
--
-- No backfill needed — new tables; existing bookings simply have no token
-- until one is minted (the landlord can issue one from the booking).

CREATE TABLE booking_guest_access_tokens (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  token text NOT NULL,
  booking_id uuid NOT NULL REFERENCES unit_bookings(id) ON DELETE CASCADE,
  landlord_id uuid NOT NULL,
  -- 'email' (link sent to guest_email) or 'qr' (host shows/print on-site).
  delivery_method text NOT NULL DEFAULT 'email',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by_user_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT booking_guest_access_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT booking_guest_access_tokens_token_key UNIQUE (token),
  CONSTRAINT booking_guest_access_tokens_delivery_check
    CHECK (delivery_method = ANY (ARRAY['email'::text, 'qr'::text]))
);

CREATE INDEX idx_booking_guest_tokens_booking ON booking_guest_access_tokens (booking_id);

CREATE TABLE booking_change_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  booking_id uuid NOT NULL REFERENCES unit_bookings(id) ON DELETE CASCADE,
  landlord_id uuid NOT NULL,
  request_type text NOT NULL,
  -- Free-text detail the guest gave (e.g. "checkout at 2pm instead of 11").
  details text,
  status text NOT NULL DEFAULT 'requested',
  resolved_at timestamptz,
  resolved_by_user_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT booking_change_requests_pkey PRIMARY KEY (id),
  CONSTRAINT booking_change_requests_type_check
    CHECK (request_type = ANY (ARRAY['late_checkout'::text, 'early_checkin'::text, 'extra_night'::text, 'other'::text])),
  CONSTRAINT booking_change_requests_status_check
    CHECK (status = ANY (ARRAY['requested'::text, 'approved'::text, 'declined'::text, 'cancelled'::text]))
);

CREATE INDEX idx_booking_change_requests_booking ON booking_change_requests (booking_id);
CREATE INDEX idx_booking_change_requests_landlord_open
  ON booking_change_requests (landlord_id) WHERE status = 'requested';

-- Admit 'guest' to the agent-logging audience CHECK (fix-forward).
ALTER TABLE agent_interaction_logs DROP CONSTRAINT IF EXISTS agent_interaction_logs_audience_check;
ALTER TABLE agent_interaction_logs ADD CONSTRAINT agent_interaction_logs_audience_check
  CHECK (audience = ANY (ARRAY['tenant'::text, 'landlord'::text, 'prospect'::text, 'guest'::text]));
