-- 10/17 (Nic) — ONE HOME FOR A TAX RATE
--
-- A lodging rate lived in THREE places and they drifted apart:
--
--   properties.short_term_tax_rate   what actually prices a stay (priceStay at
--                                    every door: the schedule, the counter, a
--                                    pay link, the booking site) — still 6.35%
--   pos_tax_rates "Lodging tax"      the named tax the landlord changed to
--                                    6.6% on 9/25, ticked on the two stay
--                                    items, and what the receipt and GAM Books
--                                    file under
--   pos_items.tax_rate               a legacy 6.35% left on the stay items
--
-- Changing one moved neither of the others, so for three weeks every
-- short-term stay at Mountain View was taxed at 6.35% while the company's own
-- tax list said 6.6%. (Amado, unincorporated Santa Cruz County: 5.5% state +
-- 1.1% county = 6.6%.) The property column was corrected by hand on 10/17.
--
-- THE FIX — the NAMED TAX LIST IS THE ONE HOME, and the others follow it.
--
--   pos_tax_rates.on_stays   the landlord says, once, "this tax is charged on a
--                            stay here". That is the fact nothing could infer:
--                            a property can take stays with no register items
--                            at all, so ticking a stay item could never be the
--                            marker.
--   properties.short_term_tax_rate
--                            now FOLLOWS the list: property_stay_tax_pct() is
--                            the one rule, and a trigger on pos_tax_rates
--                            re-reads it the moment a rate is added, changed,
--                            turned off or removed. The column keeps its name
--                            and type, so every door that prices a stay keeps
--                            reading one number — and there is no longer a
--                            second screen that can leave it behind.
--   pos_items.tax_rate       never again decides a stay's tax: a stay's line is
--                            priced whole with its lodging tax inside it, and
--                            the register's cart taxes no stay item at all
--                            (services/posTax), so a stay cannot be taxed
--                            twice whatever is ticked on it. The stay items'
--                            stale rates are cleared below.
--
-- EVERY CHANGE IS KEPT (Nic: "journal every change with who and when so a
-- filing traces to the rate in force"). pos_tax_rate_changes is append-only:
-- the rate before and after, the reach before and after, who changed it and
-- when. audit_row_changes already keeps the old row for this table but records
-- no actor, and a filing has to be able to say WHO set the rate it was
-- collected at. A change made by GAM itself (this migration) records no user.
--
-- A STAY ALREADY PRICED KEEPS THE RATE IT WAS CHARGED AT (Nic: "never reprice
-- history"). unit_bookings.stay_tax_rate stamps the rate in force when the
-- stay is priced, so a later change cannot re-rate a stay already sold: the
-- deposit and the arrival-day balance record the same rate. Stamped by a
-- trigger, not at ~10 write sites — and once a stay has taken money the stamp
-- NEVER moves again, whatever later changes its price. An early check-out, a
-- month added at the counter and a night added by an agent each write
-- total_amount and nothing else, and the review of 10/17 caught all three
-- re-stamping a PAID stay at today's rate. Only a stay that has taken nothing
-- is re-priced at today's rate, because nothing was ever collected at the old
-- one.
--
-- BACKFILLED, because leaving the stamp empty re-rates history too: a stay
-- with no stamp reads the property's rate TODAY. Production's RV 12 was rung
-- at 6.35% ten hours before the column was corrected to 6.60 (read 10/17), so
-- an early check-out would have handed back tax at a rate nobody was ever
-- charged. Every stay with no stamp takes the rate its property was charging
-- the day the stay was created, read out of the change journal
-- (audit_row_changes, never pruned): the OLDEST recorded change after that day
-- holds the figure that was in force before it.
--
-- Expand-only. No DROP, no column removed, no rate re-priced: the flips and
-- mints below carry each property's existing percentage INTO the list, so
-- nothing changes price except a property whose list already said something
-- else — which is the defect being fixed.
-- Safe drop, to put the property column back under hand control: DROP TRIGGER
-- trg_pos_tax_rates_sync_stay_tax_ins / _upd / _del ON pos_tax_rates, and
-- trg_properties_follow_stay_tax ON properties. The stamp
-- (trg_unit_bookings_stamp_stay_tax) is independent of all four and can stay.

SET LOCAL lock_timeout = '10s';

-- ── The one home says whether a tax is charged on a stay ────────────────────

ALTER TABLE pos_tax_rates
  ADD COLUMN IF NOT EXISTS on_stays boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pos_tax_rates.on_stays IS
  '10/17 (Nic): this tax is charged on a stay at this property — the lodging tax. The stay price every door charges (properties.short_term_tax_rate) follows the active on_stays rates here, with the tax inside the price; the register''s cart never taxes a stay item (services/posTax), so the same tax is never charged twice. A tax can be on stays AND on goods: each is charged once.';

-- ── Every change to a rate, with who and when ──────────────────────────────

CREATE TABLE IF NOT EXISTS pos_tax_rate_changes (
  id             bigserial PRIMARY KEY,
  landlord_id    uuid NOT NULL REFERENCES landlords(id),
  -- No reference to pos_tax_rates: the journal outlives the row it is about.
  rate_id        uuid NOT NULL,
  property_id    uuid,
  name           text NOT NULL,
  old_rate       numeric(7,4),
  new_rate       numeric(7,4),
  old_is_active  boolean,
  new_is_active  boolean,
  old_on_stays   boolean,
  new_on_stays   boolean,
  -- What the tax reached before and after (applies_to, category_ids, item_ids).
  old_reach      jsonb,
  new_reach      jsonb,
  changed_by     uuid REFERENCES users(id),
  changed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pos_tax_rate_changes_landlord
  ON pos_tax_rate_changes (landlord_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS pos_tax_rate_changes_rate
  ON pos_tax_rate_changes (rate_id, changed_at DESC);

COMMENT ON TABLE public.pos_tax_rate_changes IS
  '10/17 (Nic): every change to a named tax — the rate before and after, what it reached, who changed it and when — so a filing traces to the rate that was in force. Append-only; a change by GAM itself records no user.';

CREATE OR REPLACE FUNCTION public.pos_tax_rate_changes_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'pos_tax_rate_changes is append-only: change the rate and let the journal record it'
    USING ERRCODE = 'restrict_violation';
END $fn$;

DROP TRIGGER IF EXISTS pos_tax_rate_changes_append_only ON pos_tax_rate_changes;
CREATE TRIGGER pos_tax_rate_changes_append_only
  BEFORE UPDATE OR DELETE ON pos_tax_rate_changes
  FOR EACH ROW EXECUTE FUNCTION pos_tax_rate_changes_append_only();

-- The actor comes from the session GUC the route sets inside its own
-- transaction (fn_pos_items_log_price_change, S99, reads the same one). A
-- change made straight in SQL — this migration included — records no user.
CREATE OR REPLACE FUNCTION public.fn_pos_tax_rates_journal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  actor uuid;
  ll uuid; rid uuid; pid uuid; nm text;
  o_rate numeric(7,4); n_rate numeric(7,4);
  o_active boolean;    n_active boolean;
  o_stays boolean;     n_stays boolean;
  o_reach jsonb;       n_reach jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The same row written back is not a change (keeps the journal readable).
    IF to_jsonb(OLD) = to_jsonb(NEW) THEN RETURN NULL; END IF;
  END IF;
  BEGIN
    actor := current_setting('gam.user_id', true)::uuid;
  EXCEPTION WHEN OTHERS THEN
    actor := NULL;
  END;
  IF TG_OP <> 'INSERT' THEN
    ll := OLD.landlord_id; rid := OLD.id; pid := OLD.property_id; nm := OLD.name;
    o_rate := OLD.rate; o_active := OLD.is_active; o_stays := OLD.on_stays;
    o_reach := jsonb_build_object('appliesTo', to_jsonb(OLD.applies_to),
                                  'categoryIds', to_jsonb(OLD.category_ids),
                                  'itemIds', to_jsonb(OLD.item_ids));
  END IF;
  IF TG_OP <> 'DELETE' THEN
    ll := NEW.landlord_id; rid := NEW.id; pid := NEW.property_id; nm := NEW.name;
    n_rate := NEW.rate; n_active := NEW.is_active; n_stays := NEW.on_stays;
    n_reach := jsonb_build_object('appliesTo', to_jsonb(NEW.applies_to),
                                  'categoryIds', to_jsonb(NEW.category_ids),
                                  'itemIds', to_jsonb(NEW.item_ids));
  END IF;
  INSERT INTO pos_tax_rate_changes
    (landlord_id, rate_id, property_id, name,
     old_rate, new_rate, old_is_active, new_is_active, old_on_stays, new_on_stays,
     old_reach, new_reach, changed_by)
  VALUES (ll, rid, pid, nm, o_rate, n_rate, o_active, n_active, o_stays, n_stays,
          o_reach, n_reach, actor);
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_pos_tax_rates_journal ON pos_tax_rates;
CREATE TRIGGER trg_pos_tax_rates_journal
  AFTER INSERT OR UPDATE OR DELETE ON pos_tax_rates
  FOR EACH ROW EXECUTE FUNCTION fn_pos_tax_rates_journal();

-- ── The one rule: what a stay here is taxed at ─────────────────────────────

-- A rate bound to the property wins, and the company-wide rates (property_id
-- NULL) apply only where the property has no STAY rate of its own. Rates
-- STACK — a state rate and a county rate are two rows. Capped at the column's
-- own ceiling; a lodging tax past 100% is not a real tax.
--
-- Close to the register's cart (services/posTax) but NOT the same test, and
-- deliberately: the cart falls back to the company-wide rates only where the
-- property has no active rate of any kind, so a park holding its own sales tax
-- ignores a company-wide one on its goods. Here only the STAY rates are
-- weighed, so that same park still charges the company's lodging tax on a stay
-- — which is the whole point of naming a lodging tax company-wide.
CREATE OR REPLACE FUNCTION public.property_stay_tax_pct(p_property_id uuid)
RETURNS numeric
LANGUAGE sql STABLE AS $fn$
  WITH reaching AS (
    SELECT r.rate, r.property_id
      FROM pos_tax_rates r
      JOIN properties p ON p.id = p_property_id AND p.landlord_id = r.landlord_id
     WHERE r.is_active AND r.on_stays
       AND (r.property_id = p_property_id OR r.property_id IS NULL)
  )
  SELECT LEAST(100, COALESCE(ROUND(SUM(rate) * 100, 2), 0))
    FROM reaching
   WHERE (property_id IS NOT NULL)
         = EXISTS (SELECT 1 FROM reaching WHERE property_id IS NOT NULL)
$fn$;

COMMENT ON FUNCTION public.property_stay_tax_pct(uuid) IS
  '10/17 (Nic): the percent a stay at this property is taxed at, read from the one home (the active on_stays rows of pos_tax_rates). properties.short_term_tax_rate follows it.';

-- A rate change re-reads the column for every property of that company it
-- could have moved — one property for a property-bound rate, all of them for a
-- company-wide one, and both sides of a re-assignment. Rows that come out the
-- same are left alone, so nothing is written for a company whose stay tax did
-- not move.
CREATE OR REPLACE FUNCTION public.fn_pos_tax_rates_sync_stay_tax() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE ll uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN ll := OLD.landlord_id; ELSE ll := NEW.landlord_id; END IF;
  UPDATE properties p
     SET short_term_tax_rate = public.property_stay_tax_pct(p.id)
   WHERE p.landlord_id = ll
     AND p.short_term_tax_rate IS DISTINCT FROM public.property_stay_tax_pct(p.id);
  RETURN NULL;
END $fn$;

-- Only a stay tax moves a stay's price: an ordinary sales tax (on_stays false
-- on both sides) never touches the properties table at all.
DROP TRIGGER IF EXISTS trg_pos_tax_rates_sync_stay_tax_ins ON pos_tax_rates;
CREATE TRIGGER trg_pos_tax_rates_sync_stay_tax_ins
  AFTER INSERT ON pos_tax_rates
  FOR EACH ROW WHEN (NEW.on_stays)
  EXECUTE FUNCTION fn_pos_tax_rates_sync_stay_tax();

DROP TRIGGER IF EXISTS trg_pos_tax_rates_sync_stay_tax_upd ON pos_tax_rates;
CREATE TRIGGER trg_pos_tax_rates_sync_stay_tax_upd
  AFTER UPDATE ON pos_tax_rates
  FOR EACH ROW WHEN (NEW.on_stays OR OLD.on_stays)
  EXECUTE FUNCTION fn_pos_tax_rates_sync_stay_tax();

DROP TRIGGER IF EXISTS trg_pos_tax_rates_sync_stay_tax_del ON pos_tax_rates;
CREATE TRIGGER trg_pos_tax_rates_sync_stay_tax_del
  AFTER DELETE ON pos_tax_rates
  FOR EACH ROW WHEN (OLD.on_stays)
  EXECUTE FUNCTION fn_pos_tax_rates_sync_stay_tax();

-- ── And a property added AFTER the tax was named follows it too ────────────

-- The three triggers above run when a TAX is written. Nothing ran when a
-- PROPERTY was, so a park added to a company that already names a lodging tax
-- company-wide was born reading 0% while the one home said 6.6% — the same
-- drift, from the other side (caught in review 10/17). A property reads the
-- one home the moment it exists.
--
-- A property born carrying a figure its company never named keeps it: there is
-- nothing to follow yet, and nothing else holds the number either, so it is
-- still one home. Naming the tax on the Taxes screen takes it over from then
-- on (the only way to change it — the API refuses the figure itself).
CREATE OR REPLACE FUNCTION public.fn_properties_follow_stay_tax() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos_tax_rates r
                  WHERE r.landlord_id = NEW.landlord_id AND r.is_active AND r.on_stays
                    AND (r.property_id = NEW.id OR r.property_id IS NULL)) THEN
    RETURN NULL;
  END IF;
  UPDATE properties p
     SET short_term_tax_rate = public.property_stay_tax_pct(p.id)
   WHERE p.id = NEW.id
     AND p.short_term_tax_rate IS DISTINCT FROM public.property_stay_tax_pct(p.id);
  RETURN NULL;
END $fn$;

-- INSERT only: an UPDATE of the column is how the triggers above (and this
-- migration) set it, so firing on one would chase its own tail.
DROP TRIGGER IF EXISTS trg_properties_follow_stay_tax ON properties;
CREATE TRIGGER trg_properties_follow_stay_tax
  AFTER INSERT ON properties
  FOR EACH ROW EXECUTE FUNCTION fn_properties_follow_stay_tax();

-- ── Carrying what each company already set into the one home ───────────────

-- A tax the landlord already ticked onto STAY ITEMS AND NOTHING ELSE is a
-- lodging tax: that was the only way to say it. The flag says it now, and the
-- item ticks go — a stay's line carries its tax inside its price and is never
-- taxed by the cart, so the ticks had nothing left to do. (Mountain View's
-- "Lodging tax", 6.6% on the daily and weekly site items, read 10/17. A tax
-- that also reaches a category, a name or everything sold is left alone: GAM
-- cannot tell whether the landlord meant it on stays as well, and saying so is
-- one tick on the Taxes screen.)
UPDATE pos_tax_rates r
   SET on_stays = TRUE, item_ids = '{}'::uuid[]
 WHERE NOT r.on_stays
   AND r.is_active
   AND cardinality(r.item_ids) > 0
   AND cardinality(r.category_ids) = 0
   AND cardinality(r.applies_to) = 0
   AND NOT EXISTS (SELECT 1 FROM pos_items i WHERE i.id = ANY (r.item_ids) AND i.stay_unit IS NULL)
   AND EXISTS     (SELECT 1 FROM pos_items i WHERE i.id = ANY (r.item_ids) AND i.stay_unit IS NOT NULL);

-- A property that taxes stays but whose list never named the tax gets it
-- named, at exactly the percentage it is charging today — so nothing changes
-- price and the rate now has a home, a name on the receipt and an agency in
-- GAM Books. "Lodging tax" is what the ledger already calls it
-- (services/ledgerProjectors/registerBookingPayoutKit LODGING_TAX_NAME).
INSERT INTO pos_tax_rates (landlord_id, property_id, name, rate, tax_type, applies_to, category_ids, item_ids, on_stays)
SELECT p.landlord_id, p.id, 'Lodging tax', ROUND(p.short_term_tax_rate / 100, 4),
       'sales', '{}'::text[], '{}'::uuid[], '{}'::uuid[], TRUE
  FROM properties p
 WHERE p.short_term_tax_rate > 0
   AND NOT EXISTS (
     SELECT 1 FROM pos_tax_rates r
      WHERE r.landlord_id = p.landlord_id AND r.is_active AND r.on_stays
        AND (r.property_id = p.id OR r.property_id IS NULL));

-- The column now follows the list everywhere. For a property whose list
-- already said something else, THIS is the three-week drift closing: the stay
-- price moves to the named rate. Nothing else moves.
UPDATE properties p
   SET short_term_tax_rate = public.property_stay_tax_pct(p.id)
 WHERE p.short_term_tax_rate IS DISTINCT FROM public.property_stay_tax_pct(p.id);

COMMENT ON COLUMN public.properties.short_term_tax_rate IS
  '10/17 (Nic): DERIVED — the percent a stay here is taxed at, kept in step with the company''s own tax list (the active on_stays rows of pos_tax_rates) by trg_pos_tax_rates_sync_stay_tax. Every door prices a stay from this one number; change the rate on the Taxes screen, never here.';

-- The stale third copy: a stay item's own rate never decided a stay's tax
-- again after this, so the number is cleared rather than left to be read by
-- somebody one day. The old value stays in audit_row_changes.
UPDATE pos_items SET tax_rate = 0, updated_at = now()
 WHERE stay_unit IS NOT NULL AND tax_rate <> 0;

-- ── A stay keeps the rate it was priced at ─────────────────────────────────

ALTER TABLE unit_bookings
  ADD COLUMN IF NOT EXISTS stay_tax_rate numeric(7,4);

COMMENT ON COLUMN public.unit_bookings.stay_tax_rate IS
  '10/17 (Nic, "never reprice history"): the lodging tax rate (a fraction) in force when this stay was priced, stamped by trg_unit_bookings_stamp_stay_tax. Every payment toward the stay records its share of THIS rate, so a later change never re-rates a stay already sold. NULL on stays priced before 10/17 — they read the property''s rate, as they did before.';

-- Stamped when the stay is priced, and after that ONLY while the stay has
-- taken no money. A rate written in by hand is the writer's own and is left
-- alone (that is how the backfill below sets the old stays).
--
-- 10/17 (review) — WHY THE MONEY TEST IS HERE. A price change writes
-- total_amount and nothing else at four doors: the "charge only the nights
-- stayed" early check-out (services/earlyCheckOut), a month added at the
-- counter and its undo (services/registerStay), and a night added by the
-- guest agent. Three of those act on a stay that is PAID, so re-stamping at
-- today's rate handed back tax at a rate nobody was charged and restated a
-- past month's filing figure (services/incomeBasis reads the stamp). Once a
-- cent has come in, the rate it came in at is the stay's for good. A stay that
-- has taken nothing is re-priced at today's rate, because nothing was ever
-- collected at the old one.
CREATE OR REPLACE FUNCTION public.fn_unit_bookings_stamp_stay_tax() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE pct numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.stay_tax_rate IS NOT NULL THEN RETURN NEW; END IF;
  ELSE
    IF NEW.stay_tax_rate IS DISTINCT FROM OLD.stay_tax_rate THEN RETURN NEW; END IF;
    IF NEW.total_amount IS NOT DISTINCT FROM OLD.total_amount THEN RETURN NEW; END IF;
    IF OLD.stay_tax_rate IS NOT NULL
       AND (OLD.deposit_paid_at IS NOT NULL OR OLD.balance_paid_at IS NOT NULL
            OR EXISTS (SELECT 1 FROM stay_payments sp WHERE sp.booking_id = OLD.id)) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT p.short_term_tax_rate INTO pct
    FROM units u JOIN properties p ON p.id = u.property_id
   WHERE u.id = NEW.unit_id;
  NEW.stay_tax_rate := ROUND(COALESCE(pct, 0) / 100, 4);
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_unit_bookings_stamp_stay_tax ON unit_bookings;
CREATE TRIGGER trg_unit_bookings_stamp_stay_tax
  BEFORE INSERT OR UPDATE ON unit_bookings
  FOR EACH ROW EXECUTE FUNCTION fn_unit_bookings_stamp_stay_tax();

-- Every stay already on the books takes the rate its property was charging the
-- day the stay was created. Left empty they would read the property's rate
-- TODAY, which is the same repricing of history from the other direction:
-- production's RV 12 was rung at 6.35% on 10/17 at 10:58 and the column was
-- corrected to 6.60 at 20:56 the same evening, so an early check-out would
-- have taken out 6.60% of money collected at 6.35%.
--
-- Where the rate was is read out of the change journal (audit_row_changes —
-- never pruned, a row per UPDATE holding what the row said BEFORE it): the
-- oldest recorded change after the stay was created carries the figure in
-- force when it was created. No recorded change since means the figure never
-- moved, so today's stands. Set explicitly, so the stamp trigger above leaves
-- it exactly as written.
UPDATE unit_bookings b
   SET stay_tax_rate = ROUND(GREATEST(0, COALESCE((
         SELECT (a.old_row->>'short_term_tax_rate')::numeric
           FROM audit_row_changes a
          WHERE a.table_name = 'properties' AND a.row_id = u.property_id
            AND a.changed_at > b.created_at
            AND (a.old_row->>'short_term_tax_rate') IS NOT NULL
          ORDER BY a.changed_at ASC, a.id ASC
          LIMIT 1), p.short_term_tax_rate, 0)) / 100, 4)
  FROM units u
  JOIN properties p ON p.id = u.property_id
 WHERE u.id = b.unit_id
   AND b.stay_tax_rate IS NULL;
