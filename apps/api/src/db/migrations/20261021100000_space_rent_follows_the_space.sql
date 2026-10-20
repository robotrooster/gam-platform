-- 10/19 (Nic): UNPAID SPACE RENT FOLLOWS THE SPACE ON A TENANT-OWNED HOME.
--
--   "because mobile homes already rent the space for the ground that they're
--    parked on, Rashawn from Oak Park has left the park. The trailer has been
--    sold to somebody else, and it was not facilitated through the park. So the
--    new owner of the trailer is going to be this tenant ... He is going to be
--    responsible for paying the bill that Rashawn left behind. Because what
--    happens is when the space rent is unpaid, if it's not willingly covered by
--    the person that bought the trailer next, we can go through and get a lien
--    for the amount owed, against the trailer ... The rent is owed by the
--    trailer because it was the same trailer there. It doesn't matter how many
--    people cycle in and out. The lien attaches to the trailer."
--
-- TIED TO THE SPACE, NOT THE TRAILER. Nic: "manufactured home, they're set up.
-- They're not moving. ... There's no VIN numbers that the landlord is going to
-- have access to ... So for simplicity, we just want to attach the debt to the
-- spot." So the claim's key is unit_id and nothing here reads or requires
-- trailer identity. A landlord may still fill in year/make/model/serial/HUD
-- label on mobile_homes whenever they like, and county data may fill it in
-- later; MH 09 at Oak Park has no mobile_homes row at all and that is fine.
--
-- SPACE RENT ONLY. Nic, asked whether utilities ride along: "in terms of being
-- real and equitable, it should be the space rent is the only thing tied to the
-- trailer, right?" On MH 09 that is $880.00 of rent (Sept 1 and Oct 1) moving
-- and $1,051.00 of utilities (a $997 August water bill plus trash) staying the
-- departing resident's own debt. A utility, a fee, a deposit and a home payment
-- never move.
--
-- ONE SETTLEMENT, NOT TWO BALANCES. Nic: "Yes, Rashan is still responsible for
-- the money until it is paid. Even though it's acting as the lien, you got the
-- right method there." Both are on the hook and it must be impossible to
-- collect twice, so there is exactly ONE charge row for the money. One row can
-- only be ASKED of one household at a time, and these two columns say which:
--
--   payments.tenant_id  WHO IS ASKED FOR IT NOW — the departing resident while
--                       the space sits empty, and the resident who takes the
--                       space on from the moment their lease is drafted (the
--                       second trigger below moves it). Every payment path in
--                       GAM reads a household off this column — the front desk,
--                       the portal, autopay, a bank deposit — so it has to name
--                       the person being asked.
--   payments.lease_id   WHICH LEASE CARRIES IT — the space's current lease, so
--                       it lands on the new resident's bill as its own line.
--
-- WHOSE DEBT IT IS never moves, and the CLAIM is what holds it: origin_tenant_id,
-- with amount, settled_amount and settled_on. Nic: "it's going to just record
-- under his name only when the payment happens ... we're not recording a
-- payment like that until it's fully settled. So if somebody makes $100 a month
-- payments for a $2,000 bill and it's 20 months till it gets paid off, it's
-- gonna show that as being, you know, almost 2 years late." So the departing
-- resident's permanent record is this row rather than the charge: it keeps his
-- name, its own still-owed figure and the day the last dollar landed, and a
-- landlord reads it on the space's own window from either lease.
--
-- WHY NOT BOTH AT ONCE. An earlier draft of this file said tenant_id stays on
-- the departing resident "for good" and that the one row therefore sits in BOTH
-- households' quotes. It cannot, and the reason is worth writing down so it is
-- not re-tried: a quote reaches a lease the person is NOT on only for the rows
-- billed to THEM (creditUse.householdLeases), so whichever name is on the
-- charge is the one household that can be asked for it — and a desk payment is
-- spread across THAT household oldest-first (manualPaymentSettle settleHousehold
-- reads payment.tenant_id). Left on the departing resident, the new resident's
-- $100 at the counter would have gone to the departing resident's $997 water
-- bill. One dollar is also only ever counted once in an Outstanding total, and
-- a row in two quotes would be counted in two. The money follows the person
-- being asked; the record follows the person who owes it.
--
-- NO INVOICE, EVER. The late-fee engine (jobs/lateFees) walks INVOICES, so a
-- charge that is not a line on one is out of its reach by construction instead
-- of by a filter it could stop matching. Nic: "Rashan racked up the bill and
-- the late fees, but Jacob didn't know about it. Jacob, it was not possible for
-- him to be late. So I would say on a carry forward balance like that, just in
-- the nature of being reasonable, we drop the late fees." The charge row this
-- mechanism writes therefore carries invoice_id NULL for life, and the $95.00
-- already on MH 09 is voided outright at close-out — not moved, not left on the
-- departing resident.
--
-- TENANT-OWNED HOMES ONLY. A landlord-owned rental going vacant carries nothing
-- forward: there is no third party who inherits it. The gate is
-- units.dwelling_ownership = 'tenant' (the fact, set on 125 live spaces),
-- with home_ownerships naming the owner where a landlord has recorded one.
--
-- EXPAND-ONLY. New tables, one new nullable column, new indexes, new triggers.
-- No backfill: no space rent has ever been carried forward, and the column is
-- NULL on every existing payments row, which is correct for all of them.
-- Safe drop: DROP TABLE space_carryforward_installments, space_rent_carryforwards;
--            ALTER TABLE payments DROP COLUMN space_carryforward_id;
--            DROP TRIGGER/FUNCTION for the three triggers below.

SET LOCAL lock_timeout = '10s';

-- ── The claim ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS space_rent_carryforwards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id         uuid NOT NULL REFERENCES landlords(id),
  property_id         uuid NOT NULL REFERENCES properties(id),
  -- THE SPACE. Not the trailer: "for simplicity, we just want to attach the
  -- debt to the spot."
  unit_id             uuid NOT NULL REFERENCES units(id),

  -- Who left it behind. He stays personally liable until it is paid.
  origin_lease_id     uuid NOT NULL REFERENCES leases(id),
  origin_tenant_id    uuid NOT NULL REFERENCES tenants(id),

  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  settled_amount      numeric(12,2) NOT NULL DEFAULT 0,
  -- The late fees closed out at the same moment, kept so a landlord can see
  -- what was dropped and for whom.
  late_fees_waived    numeric(12,2) NOT NULL DEFAULT 0,

  -- The day the landlord closed the departing resident out, and the oldest
  -- carried rent's own due date, which the charge keeps so it ages honestly
  -- (the Sept 1 rent is a Sept 1 debt however long it sits).
  opened_on           date NOT NULL,
  oldest_due_date     date NOT NULL,
  opened_by           uuid REFERENCES users(id),

  -- Who took it on, stamped when their lease is drafted (the triggers below).
  assumed_lease_id    uuid REFERENCES leases(id),
  assumed_tenant_id   uuid REFERENCES tenants(id),
  assumed_at          timestamptz,

  status              text NOT NULL DEFAULT 'open',
  settled_on          date,

  -- TAKEN OFF: who wrote the balance off and the day they did it, on the
  -- property's calendar (services/spaceRentCarryforward takeOffCarryforward).
  -- Writing money off is the one action here that costs the landlord money
  -- rather than collecting it, and the change journal records what a row said,
  -- never who changed it — so the person is named on the row itself, the way
  -- opened_by and arrangement_set_by are.
  taken_off_by        uuid REFERENCES users(id),
  taken_off_on        date,

  -- WAS ANYBODY ACTUALLY ASKED (10/19, Nic). Taking the balance on is a
  -- CONDITION OF MOVING IN — "If Jacob declines, he's not moving into the park"
  -- — but the trigger below moves the charge onto whatever lease is drafted on
  -- the space, and a lease is drafted from at least four doors (the invite,
  -- tenant onboarding, issuance, stay terms). Only the invite asks. Without a
  -- column for the answer there was no way to tell a balance somebody was asked
  -- to take on from one that landed on a resident in silence, and weeks later
  -- nothing would say which had happened. Stamped by
  -- services/spaceRentCarryforward recordAssumptionAtInvite, the first time the
  -- condition is put on somebody; the sentence itself stays in notes.
  --
  -- So: assumed_lease_id set and this NULL means the balance moved onto a
  -- resident NOBODY was asked about, and the space's window says so.
  assumption_recorded_at  timestamptz,
  assumption_recorded_by  uuid REFERENCES users(id),

  -- The payment arrangement (Nic: "there's nothing that automatically bills for
  -- it right now ... we need to do, you know, payment arrangements on carry
  -- forward balances. So what, even if it's $50 or $100 or whatever."). An
  -- arrangement ASKS for an amount each cycle; it never bills a second charge,
  -- because the whole balance is already the one charge row.
  arrangement_amount      numeric(12,2) CHECK (arrangement_amount IS NULL OR arrangement_amount > 0),
  arrangement_day         integer CHECK (arrangement_day IS NULL OR arrangement_day BETWEEN 1 AND 28),
  arrangement_started_on  date,
  arrangement_set_by      uuid REFERENCES users(id),

  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT space_rent_carryforwards_status_check
    CHECK (status IN ('open', 'settled', 'voided')),
  -- A settled claim says the day it settled; an open one cannot.
  CONSTRAINT space_rent_carryforwards_settled_stamped
    CHECK ((status = 'settled') = (settled_on IS NOT NULL)),
  -- A balance taken off says the day it was taken off, and only a taken-off
  -- one can (a claim that is still owed was not written off).
  CONSTRAINT space_rent_carryforwards_taken_off_stamped
    CHECK ((status = 'voided') OR (taken_off_on IS NULL AND taken_off_by IS NULL)),
  -- An arrangement is all three answers or none of them.
  CONSTRAINT space_rent_carryforwards_arrangement_whole
    CHECK (num_nonnulls(arrangement_amount, arrangement_day, arrangement_started_on) IN (0, 3))
);

-- One open claim per space. A second would be a double-entry of the same debt:
-- the space can only have been left behind once at a time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_space_rent_carryforward_open_per_unit
  ON space_rent_carryforwards (unit_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_space_rent_carryforwards_origin_tenant
  ON space_rent_carryforwards (origin_tenant_id);
CREATE INDEX IF NOT EXISTS idx_space_rent_carryforwards_assumed_lease
  ON space_rent_carryforwards (assumed_lease_id) WHERE assumed_lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_rent_carryforwards_landlord
  ON space_rent_carryforwards (landlord_id, status);

COMMENT ON TABLE space_rent_carryforwards IS
  '10/19 (Nic): unpaid SPACE RENT left behind on a tenant-owned home, carried by the space. The departing resident stays liable (origin_tenant_id) and the space''s next lease carries it (assumed_lease_id); one charge row serves both, so it can never be collected twice.';
COMMENT ON COLUMN space_rent_carryforwards.unit_id IS
  'The space, not the trailer. Nic: "for simplicity, we just want to attach the debt to the spot."';
COMMENT ON COLUMN space_rent_carryforwards.late_fees_waived IS
  'Late fees voided at close-out. Nic: "Jacob, it was not possible for him to be late ... we drop the late fees." Never moved and never left on the departing resident.';
COMMENT ON COLUMN space_rent_carryforwards.assumption_recorded_at IS
  '10/19 (Nic): when a landlord was shown this balance and put it on a named person as a condition of moving in. NULL beside an assumed_lease_id means the balance moved onto a resident in silence — a lease drafted from a door that does not ask.';

DROP TRIGGER IF EXISTS audit_space_rent_carryforwards ON space_rent_carryforwards;
CREATE TRIGGER audit_space_rent_carryforwards
  AFTER DELETE OR UPDATE ON space_rent_carryforwards
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ── What the arrangement asked for, cycle by cycle ───────────────────────────
--
-- An asked installment is a RECORD, not a charge: the money is already owed on
-- the one carried-balance row, so writing a second charge would bill the same
-- debt twice. A missed one costs nothing — there is no invoice to fine and the
-- job never writes a late_fee row.

CREATE TABLE IF NOT EXISTS space_carryforward_installments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carryforward_id uuid NOT NULL REFERENCES space_rent_carryforwards(id) ON DELETE CASCADE,
  due_date        date NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  status          text NOT NULL DEFAULT 'asked',
  asked_on        date NOT NULL,
  met_on          date,
  -- What came in against the balance over this cycle, so "met" is measured and
  -- not asserted.
  applied_amount  numeric(12,2) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT space_carryforward_installments_status_check
    CHECK (status IN ('asked', 'met', 'missed')),
  CONSTRAINT space_carryforward_installments_met_stamped
    CHECK ((status = 'met') = (met_on IS NOT NULL))
);

-- One ask per cycle: the daily job is safe to run as often as it likes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_space_carryforward_installment_per_cycle
  ON space_carryforward_installments (carryforward_id, due_date);

COMMENT ON TABLE space_carryforward_installments IS
  '10/19 (Nic): what a payment arrangement asked for against a carried space-rent balance each cycle. A record, never a second charge, and a missed one carries no late fee.';

DROP TRIGGER IF EXISTS audit_space_carryforward_installments ON space_carryforward_installments;
CREATE TRIGGER audit_space_carryforward_installments
  AFTER DELETE OR UPDATE ON space_carryforward_installments
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ── The link from the money to the claim ─────────────────────────────────────

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS space_carryforward_id uuid REFERENCES space_rent_carryforwards(id);

COMMENT ON COLUMN payments.space_carryforward_id IS
  '10/19 (Nic): the carried space-rent claim this row belongs to — the one carried_balance charge that is the debt, its part-payment remainders, and the voided rent rows it was carried from.';

CREATE INDEX IF NOT EXISTS idx_payments_space_carryforward
  ON payments (space_carryforward_id) WHERE space_carryforward_id IS NOT NULL;

-- THE IDEMPOTENCY BACKSTOP (moneyIdempotency.test.ts). A close-out is a button
-- a human presses, and two presses on a slow connection would otherwise bill
-- the same carried balance twice. Exactly one LIVE original carried-balance
-- charge per claim, DB-enforced; the extra rows a PART payment splits off are
-- marked is_remainder and are deliberately outside the rule
-- (services/manualPaymentSettle writes them).
--
-- A 'returned' row is out of the rule for the same reason a 'voided' one is,
-- and this is not a nicety: when the bank takes an ACH payment of the carried
-- balance back, services/paymentReversal sets the paid row to 'returned' and
-- writes a fresh pending row for the money owed again. Both rows name the same
-- claim, so leaving 'returned' inside the rule made that INSERT fail and rolled
-- the whole reversal back -- the bank had the $880 back, the row still read
-- settled, and the claim still said paid off. The same shape as
-- ux_payments_unit_rent_due_date_active, which has left failed, returned and
-- voided rent rows out since 10/12 for exactly this reason: none of them is
-- owed or paid any more, so none of them holds the slot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_one_space_carryforward_charge
  ON payments (space_carryforward_id)
  WHERE space_carryforward_id IS NOT NULL
    AND type = 'carried_balance'
    AND is_remainder = false
    AND status NOT IN ('voided', 'returned');

-- ── The books mark a payment when its claim link changes ────────────────────
--
-- The charge posting depends on the link two ways
-- (services/ledgerProjectors/tenantCharges A8b: a carried_balance row that
-- names a claim moves a RECEIVABLE and earns nothing, and a voided RENT row
-- that names one keeps its charge, because the park earned that month's rent
-- whoever ends up owing it), so the capture has to see the column — the same reason
-- work_trade_settlement_id was added to this list in 20261014002000.
-- Re-installing a capture replaces its three trigger bodies only: no table
-- lock beyond a write's. The list matches LEDGER_CAPTURE_COLUMNS.payments in
-- packages/shared/src/booksLedger.ts (services/ledgerCoverage.test.ts holds the
-- two together).
SELECT ledger_install_capture('payments',
  ARRAY['landlord_id', 'unit_id', 'lease_id', 'tenant_id', 'type', 'amount', 'status', 'due_date', 'settled_at',
        'entry_description', 'lease_fee_id', 'invoice_id', 'reversal_id', 'revenue_owner', 'manual_method', 'voided_at',
        'home_sale_installment_id', 'flexpay_advance_id', 'is_remainder', 'sublease_markup_amount',
        'gam_supersedence_amount', 'payment_channel', 'issued_credit_amount', 'deposit_collected_by',
        'work_trade_credit', 'work_trade_settlement_id', 'space_carryforward_id'],
  $k$SELECT 'payment'::text, r.id::text, r.landlord_id
      UNION ALL SELECT 'remittance', ra.remittance_id::text, r.landlord_id FROM remittance_applications ra WHERE ra.payment_id = r.id$k$);

SELECT ledger_check_capture();

-- ── The claim follows the space onto whatever lease is drafted next ──────────
--
-- Nic: "If Jacob declines, he's not moving into the park. ... Space rent is
-- owed, and he can buy the trailer all he wants, but he doesn't get to move in
-- without following the rules of the park, without paying the bills." So it
-- transfers to his name when his lease is drafted.
--
-- A TRIGGER, not a call at each draft site. A lease is drafted from at least
-- five places (e-sign, the landlord route, the lease parser, stay terms, the
-- test fixtures) and a sixth will be written; CLAUDE.md's rule for a
-- units-wide invariant is a trigger rather than an audit of every call site.
-- It also means nothing has to be edited in files other sessions are holding.
--
-- This trigger changes only WHICH LEASE carries the charge, which is exactly
-- what "it follows the space" means. Who is ASKED for it is stamped by the
-- second trigger below, when the residents are added to that lease; whose debt
-- it is never moves at all (origin_tenant_id, and the claim is the record).
--
-- THE SAME GATE ON THE WAY OUT AS ON THE WAY IN. A claim is only ever CREATED
-- on a tenant-owned home (previewSpaceRentCarryforward refuses otherwise), and
-- it may only ever be INHERITED on one, because the two are the same rule read
-- from the two ends. The case is not hypothetical, it is the likeliest ending
-- of this exact situation: the park takes the abandoned home for the back rent,
-- units.dwelling_ownership flips 'tenant' -> 'landlord' on MH 09, and the park
-- drafts an ordinary park-owned rental for a brand-new renter. Nic's rule is
-- that a park-owned rental carries nothing forward -- "there is no third party
-- who inherits it" -- so without this the trigger would re-address $880 of a
-- stranger's debt to a renter who owns no home on a space the park owns.
-- The claim then simply stays where it is: open, on the departing resident's
-- own terminated lease and in his own quote, which is where it belongs, and
-- a later tenant-owned home on the space can still take it on.
--
-- Also only this landlord's, and only a lease that is a tenancy: a property
-- that changes hands (properties are transferred, never deleted) must not hand
-- the new owner a debt owed to the old one, and an expired or terminated lease
-- row written for the record is nobody to bill.
CREATE OR REPLACE FUNCTION fn_space_rent_carryforward_follows_the_space()
RETURNS trigger AS $$
DECLARE cf_id uuid;
BEGIN
  IF NEW.status NOT IN ('pending', 'active') THEN RETURN NULL; END IF;
  SELECT c.id INTO cf_id
    FROM space_rent_carryforwards c
    JOIN units u ON u.id = c.unit_id
   WHERE c.unit_id = NEW.unit_id
     AND c.status = 'open'
     AND c.origin_lease_id <> NEW.id
     AND c.landlord_id = NEW.landlord_id
     AND u.dwelling_ownership = 'tenant'
   LIMIT 1;
  IF cf_id IS NULL THEN RETURN NULL; END IF;

  UPDATE space_rent_carryforwards
     SET assumed_lease_id = NEW.id,
         -- The residents are added to lease_tenants after the lease row, so the
         -- second trigger stamps who took it on, and moves the charge to them.
         assumed_tenant_id = NULL,
         assumed_at = now(),
         updated_at = now()
   WHERE id = cf_id;

  UPDATE payments
     SET lease_id = NEW.id
   WHERE space_carryforward_id = cf_id
     AND type = 'carried_balance'
     AND status IN ('pending', 'failed');

  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_space_rent_carryforward_follows_the_space ON leases;
CREATE TRIGGER trg_space_rent_carryforward_follows_the_space
  AFTER INSERT ON leases
  FOR EACH ROW EXECUTE FUNCTION fn_space_rent_carryforward_follows_the_space();

--
-- WHO THE DESK ASKS. The charge's tenant_id moves to the resident who took the
-- space on, because that is who is asked for it now ("He is going to be
-- responsible for paying the bill that Rashawn left behind") and because every
-- payment path in GAM reads a household off the charge's own tenant_id — the
-- front desk, the portal, autopay, a bank deposit. Leaving it on the departing
-- resident would have put his $1,051 water bill in front of the new resident's
-- $100 payment, which is the opposite of what was decided.
--
-- WHOSE DEBT IT IS does not move: space_rent_carryforwards.origin_tenant_id
-- holds it for good, and the claim is what settles, with settled_on the day the
-- last dollar landed. Nic: "it's going to just record under his name only when
-- the payment happens ... we're not recording a payment like that until it's
-- fully settled", and on the new resident, "Don't count it on his, you know,
-- payment health history, his late fees ... that's carried forward as
-- Rashawn's." A carried_balance is outside payment health by type
-- (householdMonths BASE_CHARGE_TYPES), so being on his row costs him nothing.
CREATE OR REPLACE FUNCTION fn_space_rent_carryforward_assumed_by()
RETURNS trigger AS $$
DECLARE cf_id uuid;
BEGIN
  UPDATE space_rent_carryforwards
     SET assumed_tenant_id = NEW.tenant_id, updated_at = now()
   WHERE assumed_lease_id = NEW.lease_id
     AND assumed_tenant_id IS NULL
     AND status = 'open'
  RETURNING id INTO cf_id;
  IF cf_id IS NULL THEN RETURN NULL; END IF;

  UPDATE payments
     SET tenant_id = NEW.tenant_id
   WHERE space_carryforward_id = cf_id
     AND type = 'carried_balance'
     AND status IN ('pending', 'failed');
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_space_rent_carryforward_assumed_by ON lease_tenants;
CREATE TRIGGER trg_space_rent_carryforward_assumed_by
  AFTER INSERT ON lease_tenants
  FOR EACH ROW EXECUTE FUNCTION fn_space_rent_carryforward_assumed_by();

-- ── One settlement: the claim reads its own charge rows ──────────────────────
--
-- Nic: "it's going to just record under his name only when the payment happens.
-- So, and we're not recording a payment like that until it's fully settled. So
-- if somebody makes $100 a month payments for a $2,000 bill and it's 20 months
-- till it gets paid off, it's gonna show that as being, you know, almost 2
-- years late."
--
-- So a part payment must not close the claim. The claim is settled only when no
-- charge row of it is still owed, and the day it settled is the PROPERTY's day
-- the last money arrived — not the host's, and not the day a cron noticed.
-- Derived rather than set by a caller, so every path that can take money (the
-- desk, the portal, autopay, a bank deposit, a card retry) keeps it true
-- without knowing this mechanism exists.
--
-- PAID OFF AND TAKEN OFF ARE NOT THE SAME THING, and the difference is the
-- departing resident's permanent record. A charge row can leave the owed set
-- three ways, and only one of them is money:
--
--   settled / paid_via_deposit   somebody paid it            -> 'settled'
--   voided                       the landlord wrote it off   -> 'voided'
--   returned                     the bank took it back; the reopened row that
--                                replaces it is owed again   -> 'open'
--
-- Reading "nothing is owed" as "it was paid" was wrong in the one case that
-- actually happens: $100 is taken at the desk and the landlord writes the
-- remaining $780 off (services/chargeVoids, which accepts any pending row and
-- knows nothing about this claim). The claim then said 'settled' on 89% unpaid
-- money, stamped a settled_on nothing settled on, and Rashawn's record said the
-- $880 cleared — while the same screen said $780 was still owed. Written off,
-- the claim is 'voided' ("Taken off"): settled_amount keeps the $100 that was
-- really paid, settled_on stays empty, and nobody is asked for the rest.
CREATE OR REPLACE FUNCTION fn_space_rent_carryforward_rollup()
RETURNS trigger AS $$
DECLARE
  cf_id      uuid;
  still_owed numeric;
  paid       numeric;
  taken_off  numeric;
  last_day   date;
  was        text;
  becomes    text;
BEGIN
  cf_id := COALESCE(NEW.space_carryforward_id, OLD.space_carryforward_id);
  IF cf_id IS NULL THEN RETURN NULL; END IF;

  SELECT c.status INTO was FROM space_rent_carryforwards c WHERE c.id = cf_id;
  IF was IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('pending', 'processing', 'failed')), 0),
         COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('settled', 'paid_via_deposit')), 0),
         COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'voided'), 0),
         MAX((p.settled_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date)
           FILTER (WHERE p.status IN ('settled', 'paid_via_deposit'))
    INTO still_owed, paid, taken_off, last_day
    FROM payments p
    LEFT JOIN units u     ON u.id = p.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
   WHERE p.space_carryforward_id = cf_id
     AND p.type = 'carried_balance';

  becomes := CASE
    -- Taken off by hand (services/spaceRentCarryforward takeOffCarryforward)
    -- and never un-taken-off by a later payment landing.
    WHEN was = 'voided'                THEN 'voided'
    WHEN still_owed > 0                THEN 'open'
    WHEN taken_off > 0                 THEN 'voided'
    WHEN paid > 0                      THEN 'settled'
    -- Nothing owed, nothing paid, nothing written off: a claim whose charge is
    -- gone some other way (a bank return whose money came back off a GAM
    -- balance instead of a new row). Still owed in substance, so still open,
    -- and the landlord can take it off.
    ELSE 'open' END;

  UPDATE space_rent_carryforwards c
     SET settled_amount = paid,
         status = becomes,
         settled_on = CASE WHEN becomes = 'settled' THEN COALESCE(last_day, CURRENT_DATE) END,
         updated_at = now()
   WHERE c.id = cf_id;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_space_rent_carryforward_rollup ON payments;
CREATE TRIGGER trg_space_rent_carryforward_rollup
  AFTER INSERT OR UPDATE OF status, amount, space_carryforward_id ON payments
  FOR EACH ROW
  WHEN (NEW.space_carryforward_id IS NOT NULL)
  EXECUTE FUNCTION fn_space_rent_carryforward_rollup();
