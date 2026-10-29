-- 10/20 (Nic, relaying Blu) — A TASK LIST IS NOT A WORK ORDER.
--
--   "He's looking at a better way for kind of a maintenance, like a task list,
--    right, for your maintenance person. He doesn't want to sit there and go
--    through and add everything as a maintenance request per se, but he wants to
--    have a list that the maintenance person can consult and check off when it's
--    done, kind of running in parallel to maintenance, sitting outside of it
--    though, where it's, you know, it's not counting how long it takes to get
--    closed after it's been open and stuff like that, like our traditional
--    maintenance stuff. It's just like a task list of, hey, you know, fix these
--    meters and do these things. It's stuff assigned by the landlord himself,
--    not necessarily requests coming from the tenant, or work orders or
--    whatever."
--
-- Asked where it lives, Nic said PER-PROPERTY, on the property page. So that is
-- what this is: a plain checklist belonging to one park. The landlord types a
-- line, the maintenance person reads the lines and ticks them off.
--
-- WHY A TABLE OF ITS OWN, WITH maintenance_requests SITTING RIGHT THERE.
--
-- Because "sitting outside of it" is the whole request, and a maintenance
-- request cannot sit outside maintenance. Every number the platform reports
-- about maintenance reads maintenance_requests: the dashboard's open and
-- emergency counts, the completed totals, the cost sums in the landlord P&L and
-- the monthly property report, and getPortfolioStats' averageDaysToComplete —
-- which is literally "how long it takes to get closed after it's been open",
-- the one statistic Nic named as the thing this must not feed. Put "fix these
-- meters" in there as a row and it is in all of them, and a park that keeps a
-- tidy checklist starts looking like a park drowning in open repairs.
--
-- Nothing reads this table but the checklist. That is not an accident of
-- today's code, it is the point of the table.
--
-- WHY NOT daily_tasks, WHICH ALSO ALREADY EXISTS.
--
-- It is close, and worth saying out loud rather than quietly building beside:
-- daily_tasks is a landlord-wide list of titles with a due date and a
-- recurrence, shown as the "Tasks" tab inside the Maintenance Portal page. Two
-- things make it the wrong home rather than merely an untidy one:
--
--   1. It is served by the maintenance portal router and gated on
--      work_orders.create / work_orders.complete / work_orders.reassign. A
--      landlord who wants somebody to tick a checkbox would have to hand them
--      work-order powers to do it, and anybody who already holds work-order
--      powers gets the checklist whether the landlord meant that or not.
--   2. It has no property. Nic picked per-property, and every row that exists
--      today has nowhere to be — so the column could only ever be nullable, and
--      every scope check on it would need a carve-out for the rows that predate
--      the idea.
--
-- Whether Blu's list should REPLACE that Tasks tab is Nic's call, not a thing to
-- decide in a migration, so the tab is untouched and still works.
--
-- HISTORY. A tick is kept, not counted: who ticked it and when stay on the row
-- for good. GAM never erases, so a landlord who wants a line off the list hides
-- it (hidden_at) and the line, its tick and its author are all still here.
--
-- RE-RUNNABLE, THE WAY EVERY OTHER MIGRATION IN THIS TREE IS. 10/20: the repo
-- gate (routes/posPropaneProduct.test.ts) applies every migration production
-- has not seen yet TWICE, because a migration that only works on a clean
-- database is one a re-run turns into an outage, and a half-applied file is
-- worse than one that was never started. Every statement below is written so
-- the second pass is a no-op: the table and the index are IF NOT EXISTS, and
-- each foreign key is dropped by name before it is added, so the names mean the
-- same thing after the second pass as after the first. Nothing is expanded or
-- rewritten by a re-run — EXPAND ONLY, and no backfill here at all.
CREATE TABLE IF NOT EXISTS property_task_list_items (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    -- The park this list belongs to. No landlord_id beside it on purpose: a
    -- property can move between the account's entities (the transfer flow
    -- rewrites properties.landlord_id), and a copy here would go stale the day
    -- that happens. Readers join properties for the owning entity instead, so
    -- there is one answer rather than two.
    property_id uuid NOT NULL,
    -- The line the landlord typed, in their words. No title/description split:
    -- "fix these meters" is the whole task.
    body text NOT NULL,
    added_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    -- Ticked: when, and by whom. Both or neither.
    done_at timestamp with time zone,
    done_by_user_id uuid,
    -- Hidden by the landlord — the GAM version of deleting a line.
    hidden_at timestamp with time zone,
    hidden_by_user_id uuid,
    CONSTRAINT property_task_list_items_pkey PRIMARY KEY (id),
    CONSTRAINT property_task_list_items_body_not_blank CHECK (btrim(body) <> ''),
    CONSTRAINT property_task_list_items_done_together
        CHECK ((done_at IS NULL) = (done_by_user_id IS NULL)),
    CONSTRAINT property_task_list_items_hidden_together
        CHECK ((hidden_at IS NULL) = (hidden_by_user_id IS NULL))
);

-- No ON DELETE CASCADE on the property: a landlord never deletes a property
-- (they transfer it), so a cascade here would only ever be a way to lose a
-- park's checklist to a mistake nobody meant to be possible.
ALTER TABLE property_task_list_items
    DROP CONSTRAINT IF EXISTS property_task_list_items_property_id_fkey;
ALTER TABLE property_task_list_items
    ADD CONSTRAINT property_task_list_items_property_id_fkey
    FOREIGN KEY (property_id) REFERENCES properties(id);
ALTER TABLE property_task_list_items
    DROP CONSTRAINT IF EXISTS property_task_list_items_added_by_user_id_fkey;
ALTER TABLE property_task_list_items
    ADD CONSTRAINT property_task_list_items_added_by_user_id_fkey
    FOREIGN KEY (added_by_user_id) REFERENCES users(id);
ALTER TABLE property_task_list_items
    DROP CONSTRAINT IF EXISTS property_task_list_items_done_by_user_id_fkey;
ALTER TABLE property_task_list_items
    ADD CONSTRAINT property_task_list_items_done_by_user_id_fkey
    FOREIGN KEY (done_by_user_id) REFERENCES users(id);
ALTER TABLE property_task_list_items
    DROP CONSTRAINT IF EXISTS property_task_list_items_hidden_by_user_id_fkey;
ALTER TABLE property_task_list_items
    ADD CONSTRAINT property_task_list_items_hidden_by_user_id_fkey
    FOREIGN KEY (hidden_by_user_id) REFERENCES users(id);

-- The one read there is: this park's list, oldest line first (the order the
-- landlord typed them is the order they belong in).
CREATE INDEX IF NOT EXISTS property_task_list_items_property_idx
    ON property_task_list_items (property_id, created_at);

COMMENT ON TABLE property_task_list_items IS
  '10/20 (Blu, via Nic): a plain checklist on one property. The landlord adds lines, the '
  'maintenance person ticks them off. Deliberately OUTSIDE maintenance: no status, no '
  'priority, no assignment, no duration, and nothing that reports on maintenance reads it — '
  'Nic: "it''s not counting how long it takes to get closed after it''s been open".';

COMMENT ON COLUMN property_task_list_items.body IS
  'The task in the landlord''s own words, e.g. "fix these meters". The whole task — there is no title.';

COMMENT ON COLUMN property_task_list_items.done_at IS
  'When it was ticked. Kept, never counted: no report measures the gap between created_at and this.';

COMMENT ON COLUMN property_task_list_items.hidden_at IS
  'The landlord took the line off the list. GAM never erases, so the row, its tick and its author stay.';
