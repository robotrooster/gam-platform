-- 10/12 (Nic) — WHAT COLLECTED EACH GAM CHARGE, AS A RECORD (ledger design P0, M0a).
--
-- A landlord_gam_charges row says how much of it has been collected
-- (collected_amount) and, once all of it has, when (collected_at). It never
-- said FROM WHAT. GAM collects a charge two ways (services/landlordGamAccount):
--
--   1. netted out of a payout: the weekly batch keeps it back from the money
--      on its way to the landlord (platform_transfer_intents.gam_fees_kept_amount
--      is the total kept per batch, never per charge);
--   2. a bank pull from the landlord (landlord_gam_debits, charge_ids).
--
-- Without a per-charge record, the same charge could be collected by BOTH and
-- nothing would show it: netting never skipped a charge already inside a
-- pending bank pull, and the pull's settlement then marked it collected again
-- (fixed in code alongside this table). The books need to post each
-- collection on its own day against its own source (design §6 G2/H5/H6).
--
-- One row per (charge, source): exactly one of platform_transfer_intent_id or
-- landlord_gam_debit_id. Written by the code in the same transaction as the
-- collection itself. Keep-everything: never updated, never deleted by the app.
-- The charge it belongs to cascades only because charges themselves cascade
-- from their company (no app path deletes either).
--
-- BACKFILL (derived, flagged): replays every past collection oldest first —
-- each batch's gam_fees_kept_amount across that company's charges oldest first
-- (exactly what netAgainstDisbursement did), and each succeeded pull across its
-- own charge_ids — and refuses unless every charge's collections add up to its
-- collected_amount and every pull's collections to what it pulled. Production
-- 10/12: 4 batches ($82 + $48 + $175.50 + $6 = $311.50) and 1 pull ($54) = the
-- $365.50 collected on the 9 charges. The replay is a function so it can be run
-- again after the code ships: a payout that runs between this migration and the
-- deploy nets with the old code and writes no rows (SELECT
-- landlord_gam_charge_collections_backfill() fills them; it is idempotent).

CREATE TABLE IF NOT EXISTS landlord_gam_charge_collections (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id                   uuid NOT NULL REFERENCES landlord_gam_charges(id) ON DELETE CASCADE,
  -- RESTRICT (the default): a payout batch or a bank pull is never erased
  -- from under what it collected.
  platform_transfer_intent_id uuid REFERENCES platform_transfer_intents(id),
  landlord_gam_debit_id       uuid REFERENCES landlord_gam_debits(id),
  amount                      numeric(12,2) NOT NULL,
  collected_at                timestamptz NOT NULL DEFAULT now(),
  -- TRUE on rows this migration's replay wrote rather than the code at the
  -- moment of collection.
  derived                     boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landlord_gam_charge_collections_amount_positive CHECK (amount > 0),
  CONSTRAINT landlord_gam_charge_collections_one_source
    CHECK ((platform_transfer_intent_id IS NULL) <> (landlord_gam_debit_id IS NULL))
);

-- A batch or a pull collects a given charge once.
CREATE UNIQUE INDEX IF NOT EXISTS landlord_gam_charge_collections_by_intent
  ON landlord_gam_charge_collections (platform_transfer_intent_id, charge_id)
  WHERE platform_transfer_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS landlord_gam_charge_collections_by_debit
  ON landlord_gam_charge_collections (landlord_gam_debit_id, charge_id)
  WHERE landlord_gam_debit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS landlord_gam_charge_collections_charge
  ON landlord_gam_charge_collections (charge_id);

-- A money table is journaled from the migration that creates it (CLAUDE.md,
-- 10/12: the change journal is never pruned). Same trigger, same name, as
-- 20261013100000_audit_money_tables gives every money table.
DROP TRIGGER IF EXISTS audit_landlord_gam_charge_collections ON landlord_gam_charge_collections;
CREATE TRIGGER audit_landlord_gam_charge_collections
  AFTER DELETE OR UPDATE ON landlord_gam_charge_collections
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE landlord_gam_charge_collections IS
  '10/12 (ledger P0): one row per GAM charge collected per source — a payout batch that netted it (platform_transfer_intent_id) or a bank pull that collected it (landlord_gam_debit_id). Σ amount per charge = landlord_gam_charges.collected_amount. derived = written by the 20261013090000 replay, not at collection.';

-- The replay. Idempotent: an event (batch or pull) that already has rows is
-- skipped, so the code's own rows and earlier runs are never touched or
-- doubled. Raises (and so rolls back) when the money does not tie.
CREATE OR REPLACE FUNCTION landlord_gam_charge_collections_backfill()
RETURNS TABLE (rows_written integer, amount_written numeric) LANGUAGE plpgsql AS $$
DECLARE
  ev        record;
  ch        record;
  left_amt  numeric;
  take      numeric;
  n         integer := 0;
  total     numeric := 0;
  bad       text;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _gam_charge_left (id uuid PRIMARY KEY, landlord_id uuid, created_at timestamptz, left_amount numeric) ON COMMIT DROP;
  TRUNCATE _gam_charge_left;
  INSERT INTO _gam_charge_left SELECT c.id, c.landlord_id, c.created_at, c.amount FROM landlord_gam_charges c;

  -- Every collection that ever happened, in the order it happened: a batch
  -- netted at its RESERVE (the intent's created_at, the same NOW() the netting
  -- stamped on a charge it finished), a pull at its settlement.
  FOR ev IN
    SELECT 'intent'::text AS kind, i.id, i.landlord_id, i.created_at AS at,
           i.gam_fees_kept_amount AS amt, NULL::uuid[] AS charge_ids,
           EXISTS (SELECT 1 FROM landlord_gam_charge_collections x WHERE x.platform_transfer_intent_id = i.id) AS done
      FROM platform_transfer_intents i
     WHERE i.landlord_id IS NOT NULL AND i.gam_fees_kept_amount > 0
    UNION ALL
    SELECT 'debit', d.id, d.landlord_id, d.settled_at, d.total_amount, d.charge_ids,
           EXISTS (SELECT 1 FROM landlord_gam_charge_collections x WHERE x.landlord_gam_debit_id = d.id)
      FROM landlord_gam_debits d
     WHERE d.status = 'succeeded'
     ORDER BY at, kind, id
  LOOP
    IF ev.done THEN
      -- Already on file (written by the code, or by an earlier run): what it
      -- collected is what its own rows say, never a re-derivation.
      UPDATE _gam_charge_left l SET left_amount = l.left_amount - x.amount
        FROM landlord_gam_charge_collections x
       WHERE x.charge_id = l.id
         AND (x.platform_transfer_intent_id = ev.id OR x.landlord_gam_debit_id = ev.id);
    ELSIF ev.kind = 'intent' THEN
      left_amt := ev.amt;
      FOR ch IN
        SELECT l.id, l.left_amount FROM _gam_charge_left l
         WHERE l.landlord_id = ev.landlord_id AND l.left_amount > 0 AND l.created_at <= ev.at
         ORDER BY l.created_at, l.id
      LOOP
        EXIT WHEN left_amt <= 0;
        take := LEAST(ch.left_amount, left_amt);
        INSERT INTO landlord_gam_charge_collections
          (charge_id, platform_transfer_intent_id, amount, collected_at, derived)
        VALUES (ch.id, ev.id, take, ev.at, true);
        n := n + 1; total := total + take;
        UPDATE _gam_charge_left SET left_amount = left_amount - take WHERE id = ch.id;
        left_amt := left_amt - take;
      END LOOP;
      IF left_amt > 0 THEN
        RAISE EXCEPTION 'GAM charge collections replay: payout batch % kept % of GAM charges that no charge of its company can explain', ev.id, left_amt;
      END IF;
    ELSE
      left_amt := ev.amt;
      FOR ch IN
        SELECT l.id, l.left_amount FROM _gam_charge_left l
         WHERE l.id = ANY (ev.charge_ids) AND l.left_amount > 0
         ORDER BY l.created_at, l.id
      LOOP
        INSERT INTO landlord_gam_charge_collections
          (charge_id, landlord_gam_debit_id, amount, collected_at, derived)
        VALUES (ch.id, ev.id, ch.left_amount, ev.at, true);
        n := n + 1; total := total + ch.left_amount;
        left_amt := left_amt - ch.left_amount;
        UPDATE _gam_charge_left SET left_amount = 0 WHERE id = ch.id;
      END LOOP;
      -- A pull that took more than its charges still owed collected some of
      -- them a second time (the double collection this table exists to show).
      IF left_amt <> 0 THEN
        RAISE EXCEPTION 'GAM charge collections replay: bank pull % took % and its charges explain %', ev.id, ev.amt, ev.amt - left_amt;
      END IF;
    END IF;
  END LOOP;

  SELECT string_agg(format('%s (collected %s, records %s)', c.id, c.collected_amount, COALESCE(s.amt, 0)), '; ')
    INTO bad
    FROM landlord_gam_charges c
    LEFT JOIN (SELECT charge_id, SUM(amount) AS amt FROM landlord_gam_charge_collections GROUP BY charge_id) s
      ON s.charge_id = c.id
   WHERE COALESCE(s.amt, 0) <> c.collected_amount;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'GAM charge collections do not tie to collected_amount: %', bad;
  END IF;

  RETURN QUERY SELECT n, total;
END $$;

COMMENT ON FUNCTION landlord_gam_charge_collections_backfill() IS
  '10/12 (ledger P0): idempotent replay of past GAM charge collections into landlord_gam_charge_collections (derived rows). Run by migration 20261013090000 and again after the code that writes the rows itself is live.';

SELECT * FROM landlord_gam_charge_collections_backfill();
