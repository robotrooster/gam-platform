-- ─────────────────────────────────────────────────────────────────────────────
-- INCOME THAT HAPPENED BEFORE GAM — attributed to a SPACE and a PERSON,
-- never to a lease (11/1, Nic).
--
--   "We also need to have it not gated on leases, because income that happened
--    for a property may not attach to a lease. If it's an RV park or a
--    short-term stay situation, it needs to be this unit brought this much
--    money, attributed to this person's contact information. To their customer,
--    their GAM customer profile that we're making."
--
-- WHY A TABLE OF ITS OWN, AND NOT THE THREE PLACES THAT ALREADY HOLD MONEY.
--
--   `payments` is the TENANT RENT RAIL. It has no way to point at a person who
--     is not a tenant — no customer, guest or profile column — and all 876 rows
--     on it carry both a lease and a tenant. It is also the rail balances,
--     collections, autopay and late fees all read, so putting pre-GAM history
--     on it would put history inside the machinery that chases people for money.
--
--   `unit_bookings` is where stay money lives, and it is DELIBERATELY SEALED:
--     DELETE is refused outright and each night is frozen in
--     unit_occupancy_nights, built 10/21 so a landlord cannot erase or re-date
--     history to cut GAM's fee. Back-filling pre-GAM stays as reservations
--     would therefore write past NIGHTS — and GAM's own per-unit fee is
--     computed off nights, so the operator would be charged a subscription fee
--     on income they earned before they ever joined. That is the opposite of
--     what the sealing rule is for.
--
--   `pos_transactions` is a till record of a sale that happened at a register
--     on GAM. These did not.
--
-- So this is its own record, and what it is NOT is the load-bearing part:
--
--   * NEVER a charge. Nobody owes it, it is already money received. It can
--     never be billed, pulled, retried, late-feed or collected.
--   * NEVER on GAM's fee. It predates the operator's account; GAM bills for
--     evidence of use ON the platform ([[gam-what-gam-bills-for]]) and this is
--     evidence of use before it.
--   * NEVER in a balance. It is income, not a receivable.
--   * NEVER shown to the person (Nic, 11/1: landlord and GAM only). Figures
--     hand-entered off an operator's old paper ledger must not reach a customer
--     who could reasonably dispute them.
--
-- What it IS: the operator's own books. It counts as income for the month it
-- happened in, on the income reports and in GAM Books, so a park that joined in
-- October can still show September.
--
-- ATTRIBUTION. The space is required — that is the whole point Nic made ("this
-- unit brought this much money"). The person is a `customer_profiles` row, the
-- one identity GAM keeps platform-wide on name plus phone
-- ([[gam-one-customer-profile-platform-wide]]), and it is OPTIONAL on purpose:
-- an operator reading a three-year-old sheet may have the space, the date and
-- the amount but no legible name, and refusing the row would lose real income
-- for a missing surname. A row with no person is still the unit's income.
--
-- No backfill needed: nothing exists to migrate. Safe drop: this table is read
-- by reports only.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pre_gam_income_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id        uuid NOT NULL REFERENCES landlords(id),
  -- The space that earned it. Required: it is the unit of attribution.
  unit_id            uuid NOT NULL REFERENCES units(id),
  -- Who paid it, where the operator knows. Optional (see the header).
  customer_profile_id uuid REFERENCES customer_profiles(id),
  -- What the operator wrote down, kept verbatim even when no profile matched,
  -- so a name on a paper sheet is never lost to a failed match.
  payer_name         text,
  payer_phone        text,
  payer_email        text,
  -- The day the money actually arrived. This is what puts it in a month.
  occurred_on        date NOT NULL,
  amount             numeric(12,2) NOT NULL CHECK (amount > 0),
  -- Same vocabulary the import already speaks.
  income_type        text NOT NULL
                       CHECK (income_type IN ('rent','fee','deposit','utility','late_fee','stay','other')),
  -- How they paid and the operator's own reference, for their records.
  method             text,
  reference          text,
  notes              text,
  -- Where the figures came from, so a bad file can be found again and undone.
  import_source      text NOT NULL,
  import_batch_id    uuid NOT NULL,
  imported_at        timestamptz NOT NULL DEFAULT NOW(),
  imported_by_user_id uuid NOT NULL REFERENCES users(id),
  -- Keep-everything: a row entered in error is voided, never deleted.
  voided_at          timestamptz,
  void_reason        text,
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  updated_at         timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT pre_gam_income_voided_is_stamped
    CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

-- The reports read it by company and month; the batch index is what makes an
-- import reversible in one statement.
CREATE INDEX IF NOT EXISTS idx_pre_gam_income_landlord_month
  ON pre_gam_income_history (landlord_id, occurred_on) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pre_gam_income_unit
  ON pre_gam_income_history (unit_id, occurred_on) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pre_gam_income_batch
  ON pre_gam_income_history (import_batch_id);
CREATE INDEX IF NOT EXISTS idx_pre_gam_income_profile
  ON pre_gam_income_history (customer_profile_id) WHERE customer_profile_id IS NOT NULL;

-- The same row twice from one file is a double-count of real money. One row per
-- space, day, amount and type within a batch.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pre_gam_income_no_duplicate_in_batch
  ON pre_gam_income_history (import_batch_id, unit_id, occurred_on, amount, income_type)
  WHERE voided_at IS NULL;

-- This table holds money, so the change journal carries what a row said before
-- anybody edited it. Never pruned (CLAUDE.md).
DROP TRIGGER IF EXISTS audit_pre_gam_income_history ON pre_gam_income_history;
CREATE TRIGGER audit_pre_gam_income_history
  AFTER UPDATE OR DELETE ON pre_gam_income_history
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE pre_gam_income_history IS
  'Income an operator earned BEFORE joining GAM, imported for their own books (11/1, Nic). Attributed to a unit and, where known, a customer_profiles person — never to a lease, because RV and short-stay income often has none. It is money already received: never a charge, never in a balance, never collectible, never on GAM''s own fee (it predates the account), and never shown to the person it names. Counts as income for the month in occurred_on.';
COMMENT ON COLUMN pre_gam_income_history.customer_profile_id IS
  'The platform-wide person this money came from, matched on name + phone. Optional on purpose: an operator reading an old paper sheet may have the space, date and amount but no legible name, and the income is still the unit''s.';
COMMENT ON COLUMN pre_gam_income_history.import_batch_id IS
  'One id per imported file, so a whole bad import can be voided together.';
