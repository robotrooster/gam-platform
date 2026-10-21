-- 10/20 (Nic) — ONE TASK LIST, NOT TWO.
--
-- Blu's per-property task list went in yesterday (20261022150000). That
-- migration said out loud that it was building BESIDE an older landlord-wide
-- list — daily_tasks, the "Tasks" tab inside the Maintenance Portal, with due
-- dates and daily/weekly/monthly repeats, half-used — and that whether the new
-- list should replace it was Nic's call rather than a migration's.
--
-- Nic made that call. Of another duplicated surface the same evening:
--
--     "That doesn't need to be its own tab. That's kind of ridiculous."
--
-- Two task lists is exactly the redundancy he asks to have flagged, so the old
-- one stops being offered: the tab goes, its two write endpoints go, and the
-- lines still waiting to be done move onto the park's list where the
-- maintenance person is already looking.
--
-- KEEP ITS DATA. GAM never erases, and a repeat rule somebody set up is a
-- decision, not clutter. Not one daily_tasks row is deleted, emptied or marked
-- done by this migration. Every row stays exactly as it was, plus a pointer
-- saying where its line went — or, when it could not be placed, a note in plain
-- words saying why it was left alone.
--
-- WHICH PARK AN OLD LINE BELONGS TO, given daily_tasks has no property at all.
-- Nic: an item that names no property goes where its own record points, and one
-- that points nowhere stays where it is and gets said out loud rather than
-- guessed at. Two things on the row genuinely point somewhere:
--
--   1. The person it was given to. If that person works exactly one of this
--      company's parks (their own scope row says so), that is the park the line
--      is about — there is nowhere else they could do it.
--   2. The company itself. If the entity owns one park, the line can only mean
--      that park.
--
-- Anything else — no assignee and several parks, or an assignee who covers all
-- of them — is a guess, and a guess puts somebody's job on the wrong park. Those
-- rows stay on the old list with the reason written on them, and the count comes
-- back from the function so a person can see how many there were.
--
-- A REPEAT BECOMES AN OPEN LINE, AND SAYS SO IN ITS OWN WORDS. The park's list
-- has no due date and no recurrence, and that is not an omission — 20261022150000
-- lists the absences and says the absences are the feature ("nothing here is
-- late, because nothing here is tracked"). Growing a recurrence column onto it
-- to carry four half-used rows would undo the thing Nic asked for. So the
-- when-ness is written into the line the way a landlord would say it out loud —
-- "Check the pool chemicals (was due Oct 4, 2026 and set to repeat every day)" —
-- which loses no instruction, invents no machinery, and leaves the original
-- repeat rule sitting in daily_tasks where it always was. A repeat is never
-- dropped silently; it is either in the line's words or the row was not folded.
--
-- WHY A FUNCTION RATHER THAN A ONE-SHOT UPDATE. This migration reaches
-- production before the code that removes the tab does (migrations hit prod
-- now, code ships later), so for the gap between them a landlord can still add
-- a line to the old list. The fold is idempotent — it only looks at rows that
-- are still open and not yet folded — so it can be run again by hand afterwards
-- to catch anything that landed in the gap:
--
--     SELECT * FROM fold_old_task_list_into_property_lists();
--
-- One SELECT, deliberately not a nightly job: a job is a mechanism nobody asked
-- for, and after the tab is gone there is nothing left to write to the old list.
-- Only completed rows and rows nobody could place are ever left behind.

-- RE-RUNNABLE, AND THAT IS NOT A DETAIL HERE. The fold below is idempotent on
-- purpose — this migration reaches production before the code that removes the
-- old tab, so it is MEANT to be run a second time by hand to catch whatever
-- landed in the gap. A file whose function can be re-run but whose columns
-- cannot is a file nobody can actually re-run: the second pass died on
-- `ADD COLUMN` before it ever reached the fold. So the columns are IF NOT
-- EXISTS and the foreign key is dropped by name before it is added, matching
-- every sibling in this tree. EXPAND ONLY: two columns added, nothing dropped,
-- nothing rewritten.
ALTER TABLE daily_tasks
    ADD COLUMN IF NOT EXISTS folded_into_property_task_id uuid,
    ADD COLUMN IF NOT EXISTS fold_note text;

-- No cascade: the park's line is the live one now, and losing the link back to
-- where it came from is exactly the history GAM keeps.
ALTER TABLE daily_tasks
    DROP CONSTRAINT IF EXISTS daily_tasks_folded_into_property_task_id_fkey;
ALTER TABLE daily_tasks
    ADD CONSTRAINT daily_tasks_folded_into_property_task_id_fkey
    FOREIGN KEY (folded_into_property_task_id) REFERENCES property_task_list_items(id);

COMMENT ON COLUMN daily_tasks.folded_into_property_task_id IS
  '10/20 (Nic): the line on a property task list this item became when the old landlord-wide '
  'Tasks tab was retired. The row here is kept as it was — GAM never erases — and this says where to '
  'look for the live copy. NULL means it was never folded: it was already done, or nothing on it said '
  'which park it belonged to (see fold_note).';

COMMENT ON COLUMN daily_tasks.fold_note IS
  'Why this item was left on the old list instead of being folded onto a property, in plain words. '
  'Nic 10/20: an item that points nowhere is said out loud, not guessed at.';

CREATE OR REPLACE FUNCTION fold_old_task_list_into_property_lists()
RETURNS TABLE (folded integer, left_alone integer)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fold$
DECLARE
    item        record;
    parks       uuid[];
    park        uuid;
    owner_user  uuid;
    line        text;
    repeats     text;
    when_said   text;
    new_line_id uuid;
    n_folded    integer := 0;
    n_left      integer := 0;
BEGIN
    FOR item IN
        SELECT d.id, d.landlord_id, d.title, d.description, d.due_date,
               d.recurrence, d.assigned_to, d.created_at
          FROM daily_tasks d
         -- A done item has nothing left to do, so there is nothing to put on a
         -- checklist; its record stays here, ticked, with who finished it.
         WHERE d.completed = FALSE
           AND d.folded_into_property_task_id IS NULL
         ORDER BY d.created_at, d.id
    LOOP
        park := NULL;

        -- 1. The person it was given to, when they work exactly one of this
        --    company's parks. A worker set to all_properties points at every
        --    park, which points at none of them.
        IF item.assigned_to IS NOT NULL THEN
            SELECT array_agg(DISTINCT s.property_id) INTO parks
              FROM (
                SELECT user_id, landlord_id, unnest(property_ids) AS property_id
                  FROM maintenance_worker_scopes WHERE all_properties = FALSE
                UNION ALL
                SELECT user_id, landlord_id, unnest(property_ids) AS property_id
                  FROM onsite_manager_scopes WHERE all_properties = FALSE
                UNION ALL
                SELECT user_id, landlord_id, unnest(property_ids) AS property_id
                  FROM property_manager_scopes WHERE all_properties = FALSE
              ) s
              JOIN properties p ON p.id = s.property_id AND p.landlord_id = item.landlord_id
             WHERE s.user_id = item.assigned_to
               AND s.landlord_id = item.landlord_id;
            IF parks IS NOT NULL AND array_length(parks, 1) = 1 THEN
                park := parks[1];
            END IF;
        END IF;

        -- 2. The company itself, when it owns one park. Then the line can only
        --    be about that park.
        IF park IS NULL THEN
            SELECT array_agg(p.id) INTO parks
              FROM properties p WHERE p.landlord_id = item.landlord_id;
            IF parks IS NOT NULL AND array_length(parks, 1) = 1 THEN
                park := parks[1];
            END IF;
        END IF;

        IF park IS NULL THEN
            UPDATE daily_tasks
               SET fold_note = 'Left on the old list: nothing on this item names a property, and the '
                               'company it belongs to has more than one. Putting somebody''s job on the '
                               'wrong park is worse than leaving it here, so it was not guessed at.'
             WHERE id = item.id;
            n_left := n_left + 1;
            CONTINUE;
        END IF;

        -- The line, in the words that were typed. Title and detail read as one
        -- sentence because the park's list has no title/detail split: the whole
        -- thing is the task.
        line := btrim(coalesce(item.title, ''));
        IF coalesce(btrim(item.description), '') <> '' THEN
            line := CASE WHEN line = '' THEN btrim(item.description)
                         ELSE line || ' — ' || btrim(item.description) END;
        END IF;
        IF line = '' THEN
            -- The old POST had no title validator, so a wordless row is
            -- possible. There is nothing to put on a checklist.
            UPDATE daily_tasks
               SET fold_note = 'Left on the old list: the item has no words on it, so there is nothing '
                               'to put on a park''s list.'
             WHERE id = item.id;
            n_left := n_left + 1;
            CONTINUE;
        END IF;

        -- The due date and the repeat, said the way a landlord would say them.
        -- Never a raw enum: 'weekly' is not a thing anybody says out loud.
        repeats := CASE item.recurrence
                     WHEN 'none'    THEN NULL
                     WHEN 'daily'   THEN 'every day'
                     WHEN 'weekly'  THEN 'every week'
                     WHEN 'monthly' THEN 'every month'
                     ELSE replace(item.recurrence, '_', ' ')
                   END;
        when_said := NULL;
        IF item.due_date IS NOT NULL AND repeats IS NOT NULL THEN
            when_said := 'was due ' || to_char(item.due_date, 'FMMon FMDD, YYYY')
                         || ' and set to repeat ' || repeats;
        ELSIF item.due_date IS NOT NULL THEN
            when_said := 'was due ' || to_char(item.due_date, 'FMMon FMDD, YYYY');
        ELSIF repeats IS NOT NULL THEN
            when_said := 'was set to repeat ' || repeats;
        END IF;
        IF when_said IS NOT NULL THEN
            line := line || ' (' || when_said || ')';
        END IF;

        -- Whose line it is. The old list was the landlord's own list, so the
        -- folded line is theirs; the person it used to be assigned to is NOT
        -- carried over, because the park's list belongs to the park and not to
        -- anybody (20261022150000: "whoever is there does the next line"). Their
        -- name is still on the row here.
        SELECT l.user_id INTO owner_user FROM landlords l WHERE l.id = item.landlord_id;
        IF owner_user IS NULL THEN
            UPDATE daily_tasks
               SET fold_note = 'Left on the old list: the company that owns it has no owner account to '
                               'put the line under.'
             WHERE id = item.id;
            n_left := n_left + 1;
            CONTINUE;
        END IF;

        -- created_at is carried over, not restamped: these lines were asked for
        -- before today's, and the park's list reads in the order things were
        -- asked for.
        INSERT INTO property_task_list_items (property_id, body, added_by_user_id, created_at)
        VALUES (park, line, owner_user, item.created_at)
        RETURNING id INTO new_line_id;

        -- updated_at is deliberately left alone: a pointer to where the line
        -- went is not the landlord editing their task.
        UPDATE daily_tasks
           SET folded_into_property_task_id = new_line_id,
               fold_note = NULL
         WHERE id = item.id;
        n_folded := n_folded + 1;
    END LOOP;

    RETURN QUERY SELECT n_folded, n_left;
END;
$fold$;

COMMENT ON FUNCTION fold_old_task_list_into_property_lists() IS
  '10/20 (Nic): moves every still-open item from the retired landlord-wide Tasks list (daily_tasks) onto '
  'the park task list it belongs to, and leaves a note on the ones no park could be worked out for. '
  'Idempotent — run it again after the old tab stops being offered to catch anything added in between.';

SELECT * FROM fold_old_task_list_into_property_lists();
