-- S631 (Nic, DIRECTIVE): "My super admin account can never be removed by another
-- super admin. It needs to be a step above... it needs to be able to never be
-- removed, to never be edited, to never be downgraded." And: "I want super
-- admins to only be able to be added by me. Other super admins can only add
-- regular level admins."
--
-- WHY THIS IS A DATABASE TRIGGER AND NOT A ROUTE CHECK.
--
-- Route checks protect the routes that exist. This session has already shown
-- twice what that is worth: a co-owner membership was erased by a direct
-- database edit that no endpoint performed and no application log recorded, and
-- the only reason we could reconstruct it at all was an invitation row nobody
-- had thought to clean up. A protection on the owner account that lives in
-- TypeScript is a protection against the code path somebody remembers.
--
-- WHY IT IS PINNED BY USER ID AND NOT BY EMAIL.
--
-- `OWNER_EMAIL` matched req.user.email against a string. That is a live bug, not
-- a hypothetical one: this platform has an email-change flow (users.pending_email)
-- and Nic moved his own login off the Oak Park address earlier today. Under the
-- old check, changing his email would have silently stripped his own owner
-- powers — and handed them to whoever next registered that address. The owner is
-- an ACCOUNT, not a string, so this table holds the id.
CREATE TABLE IF NOT EXISTS platform_owner (
  -- A one-row table. The constant primary key is what enforces that: a second
  -- INSERT collides rather than quietly creating a second owner.
  only_row    boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  user_id     uuid NOT NULL REFERENCES users(id),
  established timestamptz NOT NULL DEFAULT now(),
  note        text
);

COMMENT ON TABLE platform_owner IS
  'S631: the one account that cannot be deleted, downgraded, or deactivated, and the only one that may create super admins. Deliberately not surfaced in any admin listing — other super admins should see an ordinary account.';

INSERT INTO platform_owner (user_id, note)
SELECT id, 'S631: founding owner'
  FROM users WHERE email = 'nic@golddoor.io' AND role = 'super_admin'
ON CONFLICT (only_row) DO NOTHING;

-- ── The lock itself ──────────────────────────────────────────────────
--
-- Two absolute refusals, chosen narrowly so this protects without becoming a
-- nuisance: the owner cannot be DELETED, and the owner cannot have their ROLE
-- changed. Everything else about the account stays editable — the owner must
-- still be able to change their own email, name and password, which is exactly
-- what Nic did this morning and will do again.
CREATE OR REPLACE FUNCTION protect_platform_owner() RETURNS trigger AS $$
DECLARE owner_id uuid;
BEGIN
  SELECT user_id INTO owner_id FROM platform_owner LIMIT 1;
  IF owner_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' AND OLD.id = owner_id THEN
    RAISE EXCEPTION 'The platform owner account cannot be deleted.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.id = owner_id AND NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'The platform owner''s role cannot be changed.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_platform_owner ON users;
CREATE TRIGGER trg_protect_platform_owner
  BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION protect_platform_owner();

-- The pointer is as protected as what it points at. Without this, removing the
-- owner is a two-step: repoint the row, then delete the account.
CREATE OR REPLACE FUNCTION protect_platform_owner_row() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Platform ownership cannot be changed here — it takes a migration.'
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_platform_owner_row ON platform_owner;
CREATE TRIGGER trg_protect_platform_owner_row
  BEFORE UPDATE OR DELETE ON platform_owner
  FOR EACH ROW EXECUTE FUNCTION protect_platform_owner_row();
