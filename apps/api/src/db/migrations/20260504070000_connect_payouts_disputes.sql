-- S117: Connect-side payout + dispute tracking.
--
-- Under Connect Express each landlord/PM-company Connect account has its
-- own balance and payout schedule. Stripe emits payout.created/paid/failed
-- against the connected account; GAM mirrors them locally for the
-- dashboard + audit.
--
-- Disputes hit GAM's platform balance (loss responsibility = application
-- per S113). Storing them locally lets the GAM-native dashboard surface
-- pending disputes for response.
--
-- Both tables are append-only-ish: payouts cycle pending→paid|failed
-- once; disputes can transition through several statuses but always
-- return to a terminal state.

CREATE TABLE connect_payouts (
    id                            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Stripe-side identifiers (the Connect account whose balance was paid out)
    stripe_payout_id              text NOT NULL,
    stripe_account_id             text NOT NULL,  -- Connect account id (acct_*)

    -- GAM-side attribution: which entity owns this Connect account
    user_id                       uuid REFERENCES users(id) ON DELETE SET NULL,
    pm_company_id                 uuid REFERENCES pm_companies(id) ON DELETE SET NULL,

    amount                        numeric(10,2) NOT NULL,
    currency                      text NOT NULL DEFAULT 'usd',
    status                        text NOT NULL DEFAULT 'pending',

    -- Bank routing snapshot — Stripe-side bank account id at payout time
    destination_bank_id           text,
    destination_bank_last4        text,

    arrival_date                  date,
    failure_code                  text,
    failure_message               text,

    created_at                    timestamp with time zone NOT NULL DEFAULT now(),
    updated_at                    timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT connect_payouts_status_check
      CHECK (status = ANY (ARRAY['pending', 'paid', 'failed', 'canceled', 'in_transit'])),
    CONSTRAINT connect_payouts_unique_stripe_id
      UNIQUE (stripe_payout_id)
);

CREATE INDEX idx_connect_payouts_user_status
  ON connect_payouts(user_id, status, created_at DESC);
CREATE INDEX idx_connect_payouts_pm_company_status
  ON connect_payouts(pm_company_id, status, created_at DESC) WHERE pm_company_id IS NOT NULL;
CREATE INDEX idx_connect_payouts_account
  ON connect_payouts(stripe_account_id, created_at DESC);


CREATE TABLE connect_disputes (
    id                            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_dispute_id             text NOT NULL,
    stripe_charge_id              text NOT NULL,
    stripe_payment_intent_id      text,
    -- The Connect account the disputed charge was destined to (when known)
    stripe_account_id             text,

    -- GAM-side attribution
    payment_id                    uuid REFERENCES payments(id) ON DELETE SET NULL,
    landlord_id                   uuid REFERENCES landlords(id) ON DELETE SET NULL,

    amount                        numeric(10,2) NOT NULL,
    currency                      text NOT NULL DEFAULT 'usd',
    reason                        text,
    status                        text NOT NULL,

    -- Evidence + response tracking
    evidence_due_by               timestamp with time zone,
    evidence_submitted_at         timestamp with time zone,
    response_notes                text,

    -- Outcome
    outcome                       text,           -- won | lost | warning_closed | etc.
    outcome_at                    timestamp with time zone,

    created_at                    timestamp with time zone NOT NULL DEFAULT now(),
    updated_at                    timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT connect_disputes_status_check
      CHECK (status = ANY (ARRAY[
        'warning_needs_response', 'warning_under_review', 'warning_closed',
        'needs_response',          'under_review',          'charge_refunded',
        'won',                     'lost'
      ])),
    CONSTRAINT connect_disputes_unique_stripe_id
      UNIQUE (stripe_dispute_id)
);

CREATE INDEX idx_connect_disputes_landlord_status
  ON connect_disputes(landlord_id, status, created_at DESC);
CREATE INDEX idx_connect_disputes_pending
  ON connect_disputes(evidence_due_by ASC) WHERE status IN ('warning_needs_response', 'needs_response');
