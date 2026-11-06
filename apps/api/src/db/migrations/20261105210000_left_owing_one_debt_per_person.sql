-- 11/5 (Nic) — ONE WALK-AWAY DEBT PER PERSON, FED BY MANY SOURCES.
--
--   "We need a way for it to only record once, but it needs to be able to be
--    infused from different sources. ...people have short-term stays as well.
--    Or people, 'hey, my card wasn't working when I went to buy some propane,
--    and I'm going to come back with a new card,' and they never do. That
--    wasn't a lease or a stay."
--
-- WHAT WAS WRONG. tenant_left_owing held ONE ROW PER SOURCE — unique on
-- (landlord_id, source_kind, source_key), where the key was a lease id or a
-- booking id. So a resident who walked away from a lease AND left a counter tab
-- unpaid was two debts to the same landlord, and the second landlord screening
-- them saw a pile instead of a person. It also had no way at all to record the
-- propane case Nic describes, because that is neither a lease nor a stay.
--
-- THE SHAPE NOW. The record is the PERSON, with this landlord. Each thing they
-- walked away from is a PART of it, and the amount is simply the parts added
-- up. A lease ending contributes, a deposit return that came up short
-- contributes, a stay contributes, an unpaid counter sale contributes.
--
-- WHY person_key AND NOT user_id. A walk-in guest may have no account at all —
-- a name and a phone number is everything a park has on them, and that is
-- exactly the person this book exists to catch. So the identity is the same one
-- the flag read already matches on (services/leftOwing personKey): the account
-- when there is one, otherwise the email, otherwise the phone. Keeping the two
-- in step matters — a key the matcher would not agree with would quietly split
-- one person into two debts again.
--
-- EXPAND ONLY. The old (landlord_id, source_kind, source_key) unique STAYS for
-- now and every existing row keeps its values, so nothing that reads this table
-- today can break. A later migration drops it once every writer is on the parts
-- path ([[gam-migrate-expand-then-contract]]).
--
-- BACKFILL: yes, and it must happen here. The two live rows (Country Acres MH
-- 18 and MH 28, $1,252.80 and $1,507.25, neither with anything collected
-- against it) become a person record each with one 'lease' part, so the sum
-- they carry is the sum of their parts from the first moment and no reader ever
-- sees a record whose total disagrees with its parts.

-- ── The person this debt belongs to ────────────────────────────────────────
ALTER TABLE tenant_left_owing
  ADD COLUMN IF NOT EXISTS person_key text;

-- One LIVE debt per person per landlord. Partial on settled_at so a settled
-- debt never blocks a new one: somebody who paid up and later walks away again
-- is a fresh record, not a resurrection of the old one.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_left_owing_person
  ON tenant_left_owing (landlord_id, person_key)
  WHERE settled_at IS NULL AND person_key IS NOT NULL;

-- ── What they walked away from, one row per thing ──────────────────────────
CREATE TABLE IF NOT EXISTS tenant_left_owing_parts (
  id              uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  owing_id        uuid NOT NULL REFERENCES tenant_left_owing(id) ON DELETE CASCADE,
  -- 'lease'   a tenancy that ended owing
  -- 'stay'    a reservation that was never paid off
  -- 'counter' a register sale or pay link nobody came back for
  -- 'import'  a balance another operator recorded before GAM
  kind            text NOT NULL CHECK (kind IN ('lease', 'stay', 'counter', 'import')),
  -- What it was: a lease id, a booking id, a ticket id. One part per thing.
  source_key      text NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  left_on         date,
  -- Plain words for the person reading it, never shown to another landlord.
  note            text,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at      timestamp with time zone NOT NULL DEFAULT now(),
  -- Kept, never deleted ([[gam-data-retention-keep-everything]]): a part that
  -- turns out not to be owed is voided so the change journal still explains
  -- why the total moved.
  voided_at       timestamp with time zone,
  void_reason     text,
  CONSTRAINT tenant_left_owing_parts_one_per_thing UNIQUE (owing_id, kind, source_key)
);

CREATE INDEX IF NOT EXISTS idx_left_owing_parts_owing
  ON tenant_left_owing_parts (owing_id) WHERE voided_at IS NULL;

-- Money table, so it carries the journal every money table carries
-- (CLAUDE.md: the change journal is never pruned).
DROP TRIGGER IF EXISTS audit_tenant_left_owing_parts ON tenant_left_owing_parts;
CREATE TRIGGER audit_tenant_left_owing_parts
  AFTER UPDATE OR DELETE ON tenant_left_owing_parts
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ── Backfill: every existing record becomes a person with one part ─────────
--
-- person_key mirrors services/leftOwing personKey exactly — account, else
-- email, else phone — so the matcher and this index agree about who somebody
-- is. A row with none of the three keeps a NULL key and is simply left out of
-- the uniqueness rule; it can still be matched and settled as before.
UPDATE tenant_left_owing
   SET person_key = CASE
         WHEN user_id IS NOT NULL THEN 'user:' || user_id::text
         WHEN NULLIF(btrim(COALESCE(email, '')), '') IS NOT NULL
           THEN 'email:' || lower(btrim(email))
         WHEN NULLIF(right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10), '') IS NOT NULL
           THEN 'phone:' || right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)
         ELSE NULL END
 WHERE person_key IS NULL;

INSERT INTO tenant_left_owing_parts (owing_id, kind, source_key, amount, left_on, note)
SELECT o.id,
       CASE WHEN o.source_kind = 'import' THEN 'import' ELSE o.source_kind END,
       o.source_key,
       o.amount,
       o.left_on,
       'Carried over 11/5 when this book became one debt per person.'
  FROM tenant_left_owing o
 WHERE o.amount > 0
   AND NOT EXISTS (SELECT 1 FROM tenant_left_owing_parts p WHERE p.owing_id = o.id)
ON CONFLICT (owing_id, kind, source_key) DO NOTHING;
