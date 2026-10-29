-- 10/21 (Nic) — A SUPPLY LIST BESIDE THE TASK LIST, AND WHO MAY WRITE WHICH.
--
--   "We also need a way for maybe maintenance people or work trade people to
--    put in sort of a collected shopping cart pool of, hey, we need to buy some
--    new paint brushes and new trash bags. Like, anybody can contribute to a
--    list of things to purchase. The owner can consult that list when either
--    ordering online or running to the store. But that way he doesn't have text
--    messages from like 5 or 6 different people saying we need this and we need
--    this, and, you know, consolidate the list all in one spot."
--
-- And, on the same evening, about the task list itself:
--
--   "I don't want anything added here automatically. This is stuff the landlord
--    assigns... The checkout flow already takes care of the meter reads. So
--    meter reads should not ever be here, along with changing a broken meter,
--    fixing gravel, whatever. None of that stuff should be here."
--
-- ── ONE TABLE, BECAUSE THE TWO LISTS ARE THE SAME SHAPE ─────────────────────
--
-- A line, who added it, a tick, and a way back. That is both lists. Nic killed
-- a second parallel task list the night before — "That doesn't need to be its
-- own tab. That's kind of ridiculous." — so a second parallel table for the
-- same four columns would be the same mistake wearing a shopping hat.
--
-- What actually differs is WHO MAY WRITE, and it is INVERTED between them:
--
--   job     the owner writes the line; anybody working the park ticks it off.
--           "It's stuff assigned by the landlord himself."
--   supply  ANYBODY working the park writes the line — that is the whole
--           request, five people's text messages in one place — and the OWNER
--           ticks it bought, because he is the one at the till.
--
-- One column decides it, and the routes read that column rather than guessing
-- from the words on the line.
--
-- ── WHY THE LINE BELONGS TO A PROPERTY AND THE SHOPPING VIEW GROUPS BY ENTITY
--
-- Nic, asked whether the supply list is per park or pooled, gave both halves of
-- the answer and they do not conflict:
--
--   "supply list needs to be per park because parks may not be close enough
--    together to deliver on... if I'm ordering stuff on Amazon for one park and
--    another park, I need to do it as separate transactions because it's, one,
--    going to be different bookkeeping, two, it's going to be different delivery
--    address."
--
--   "or let's put it at the entity level or LLC level. Because if I'm buying a
--    doorknob for this single family house and a new window for this other
--    single family house, if it's at the same LLC, it's going to be under the
--    same bookkeeping."
--
-- So the LINE is a property's: that is where the thing is needed and where it
-- gets delivered, and a line that did not say which house the doorknob was for
-- would be useless. The SHOPPING VIEW rolls up by ENTITY, because an order and
-- its bookkeeping are the company's — which is the rule everywhere else money
-- is grouped in GAM (Connect accounts are per entity; no money page mixes two
-- companies). Two houses in one LLC are one order with the house on each line;
-- two parks in different LLCs can never land in one order by construction.
--
-- No new table, no new scoping: `property_id` already carries both facts, since
-- a property knows its entity.

ALTER TABLE property_task_list_items
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'job';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_task_list_items_kind_check'
  ) THEN
    ALTER TABLE property_task_list_items
      ADD CONSTRAINT property_task_list_items_kind_check
      CHECK (kind IN ('job', 'supply'));
  END IF;
END $$;

COMMENT ON COLUMN property_task_list_items.kind IS
  '10/21 (Nic): ''job'' — the owner''s task list, which only the owner writes and anybody working the park ticks. ''supply'' — things to buy, which anybody working the park writes and only the owner ticks bought. Single source: PROPERTY_LIST_KINDS in packages/shared.';

-- The two lists are read separately on every screen, so the index the reads
-- actually use includes the kind.
CREATE INDEX IF NOT EXISTS idx_property_task_list_items_property_kind
  ON property_task_list_items (property_id, kind, created_at);
