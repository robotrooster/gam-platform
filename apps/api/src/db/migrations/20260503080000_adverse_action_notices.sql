-- S87 / DEFERRED Item 2: FCRA adverse action notice infrastructure.
--
-- When a landlord denies a rental application based in whole or in part on
-- information obtained from a consumer reporting agency (CRA), federal FCRA
-- §615 requires the user of the report (the landlord, with GAM as platform)
-- to provide an "adverse action notice" to the applicant within a reasonable
-- time after the decision. The notice must include:
--
--   - The CRA's name, address, and phone number
--   - A statement that the CRA did not make the decision and cannot explain
--     why the adverse action was taken
--   - Notice of the applicant's right to obtain a free copy of the report
--     from the CRA within 60 days
--   - Notice of the applicant's right to dispute accuracy with the CRA
--   - The standard CFPB "Summary of Consumer Rights under FCRA" reference
--
-- This table is the durable legal record of every notice sent. One notice
-- per denied background_check (UNIQUE on background_check_id). The full
-- rendered notice_text is stored verbatim so future template changes don't
-- alter what was actually sent — important for regulator inquiries or
-- applicant disputes years after the fact.
--
-- State-specific adverse-action requirements (e.g., California Civil Code
-- §1786.40 has additional fields) are landlord-configurable add-ons; they
-- compose with the federal notice rather than replacing it. Per the GAM
-- "no state-specific legal logic" rule, this table holds the federally-
-- required fields only.

CREATE TABLE adverse_action_notices (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    background_check_id  uuid NOT NULL REFERENCES background_checks(id) ON DELETE CASCADE,
    tenant_user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    landlord_id          uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,

    -- CRA disclosure block (FCRA §615(a)(2))
    cra_name             text NOT NULL,
    cra_address          text NOT NULL,
    cra_phone            text NOT NULL,
    cra_website          text,

    -- Landlord-supplied summary (NOT the CRA data itself — the CRA didn't
    -- make the decision and can't explain it).
    decision_basis       text,

    -- Snapshot of the risk flags at decision time, for audit. Mirrors the
    -- background_checks.risk_flags shape.
    risk_factors         jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- The full rendered notice text as sent to the applicant. Stored
    -- verbatim — template changes don't mutate historical notices.
    notice_text          text NOT NULL,

    -- FCRA gives applicants 60 days to request a free report copy. Stored
    -- here so the rendered notice and the audit record agree on the window.
    dispute_window_days  integer NOT NULL DEFAULT 60,

    -- Delivery tracking
    notice_sent_at       timestamp with time zone NOT NULL DEFAULT now(),
    email_message_id     text,

    created_at           timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT adverse_action_notices_one_per_check UNIQUE (background_check_id)
);

CREATE INDEX idx_adverse_action_notices_landlord ON adverse_action_notices(landlord_id, created_at DESC);
CREATE INDEX idx_adverse_action_notices_tenant   ON adverse_action_notices(tenant_user_id, created_at DESC);
