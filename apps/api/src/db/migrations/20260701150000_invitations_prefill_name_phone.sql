-- invitations: capture the invitee's name + phone at invite time.
--
-- Why: the landlord now enters a staff member's first/last name + phone on the
-- Team "add user" form (no more role dropdown / job-category chips). Those
-- details ride on the invitation so the acceptance page can PRE-FILL them —
-- the employee just sets a password. The accept handler already accepts
-- firstName/lastName/phone in its body; these columns are the source the
-- accept page reads to populate those fields.
--
-- Nullable + no backfill: existing pending invitations predate the columns and
-- legitimately have no pre-fill (the invitee types their own details, same as
-- before). New invites carry them.
ALTER TABLE invitations
  ADD COLUMN first_name text,
  ADD COLUMN last_name  text,
  ADD COLUMN phone      text;
