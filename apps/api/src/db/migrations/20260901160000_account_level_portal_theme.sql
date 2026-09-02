-- S633 — THE ACCOUNT IS NOT AN ENTITY.
--
-- Nic (DIRECTIVE): "I don't want my account entity to be Oak Park. I want my
-- account to just be my account. People buy and sell entities all the time."
--
-- Portal accent colour and font are chrome for the PERSON looking at the
-- screen. They were stored on `landlords` — a company — and read through
-- whichever company the session happened to be sitting on. For an account that
-- owns two companies that meant the portal changed colour depending on an
-- invisible piece of session state, and an account that sold the company it was
-- "on" would have taken its theme with it.
--
-- A theme is not an asset of an LLC. It moves to the account.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS theme_accent text,
  ADD COLUMN IF NOT EXISTS font_style   text;

COMMENT ON COLUMN users.theme_accent IS
  'S633: portal accent colour, per ACCOUNT. Chrome belongs to the person, not to any company they own.';
COMMENT ON COLUMN users.font_style IS
  'S633: portal font, per ACCOUNT. See users.theme_accent.';

-- Carry each landlord''s existing answer up to the account that set it. Where an
-- account owns several companies that were themed differently, the founding
-- entity''s answer wins — it is the one whose theme the portal was actually
-- showing, so nobody sees a change they did not make.
UPDATE users u
   SET theme_accent = l.theme_accent,
       font_style   = l.font_style
  FROM landlords l
 WHERE l.user_id = u.id
   AND (l.theme_accent IS NOT NULL OR l.font_style IS NOT NULL)
   AND u.theme_accent IS NULL
   AND u.font_style IS NULL
   AND l.id = (SELECT l2.id FROM landlords l2
                WHERE l2.user_id = u.id
                ORDER BY l2.created_at ASC LIMIT 1);

COMMENT ON COLUMN landlords.theme_accent IS
  'S633 SUPERSEDED by users.theme_accent — portal chrome is per account, not per company. Retained as the record of what was set before the move; nothing reads it.';
COMMENT ON COLUMN landlords.font_style IS
  'S633 SUPERSEDED by users.font_style. See landlords.theme_accent.';
