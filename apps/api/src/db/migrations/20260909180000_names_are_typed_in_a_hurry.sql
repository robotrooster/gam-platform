-- S639 (Nic): "On the tenant portal invites, I want to have it be title case on
-- the names. I accidentally put Gerald Logue as a lower case, and I have no way
-- to change that invite."
--
-- A tenant's name is typed once, at speed, during a bulk onboarding, and then
-- printed on their lease, their invoices and every email they ever get from us.
-- "gerald" is not a name anybody would choose to send.
--
-- Enforced by a trigger rather than at the five INSERT sites that create a user
-- (onboard-tenant, onboard-tenant-pending, the CSV commit, the parser resolve
-- and the service-agreement path), for the same reason the units rules are:
-- auditing call sites is how one gets missed.
--
-- Deliberately conservative — it corrects a name typed in ONE case and
-- otherwise leaves it exactly alone:
--   gerald            → Gerald
--   ANASTACIO ERREGUIN→ Anastacio Erreguin
--   o'brien           → O'Brien
--   mary-jane         → Mary-Jane
--   McDonald          → McDonald   (mixed case is a deliberate spelling)
--   van der Berg      → van der Berg
--   JJ, TJ            → JJ, TJ     (short all-caps words are initials)
-- Anything already carrying an internal capital says the writer meant it, and a
-- general title-caser would ruin every one of those.
CREATE OR REPLACE FUNCTION normalize_person_name(raw text) RETURNS text AS $$
DECLARE
  s text;
  word text;
  out_words text[] := '{}';
BEGIN
  s := btrim(regexp_replace(COALESCE(raw, ''), '\s+', ' ', 'g'));
  IF s = '' THEN RETURN s; END IF;
  -- Mixed case is deliberate. Leave it untouched.
  IF s ~ '[a-z]' AND s ~ '[A-Z]' THEN RETURN s; END IF;
  FOREACH word IN ARRAY string_to_array(s, ' ') LOOP
    IF word ~ '^[A-Z]{1,3}$' THEN
      out_words := out_words || word;            -- initials: JJ, TJ
    ELSE
      out_words := out_words || regexp_replace(
        lower(word), '(^|[-''’])([a-z])', '\1\2', 'g');
      -- upper-case the first letter and any letter after - or '
      out_words[array_length(out_words, 1)] := (
        SELECT string_agg(
          CASE WHEN i = 1 OR substr(lower(word), i - 1, 1) IN ('-', '''', '’')
               THEN upper(substr(lower(word), i, 1))
               ELSE substr(lower(word), i, 1) END, '' ORDER BY i)
        FROM generate_series(1, length(word)) AS i);
    END IF;
  END LOOP;
  RETURN array_to_string(out_words, ' ');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION stamp_normalized_user_name() RETURNS trigger AS $$
BEGIN
  NEW.first_name := normalize_person_name(NEW.first_name);
  NEW.last_name  := normalize_person_name(NEW.last_name);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_user_name ON users;
CREATE TRIGGER trg_normalize_user_name
  BEFORE INSERT OR UPDATE OF first_name, last_name ON users
  FOR EACH ROW EXECUTE FUNCTION stamp_normalized_user_name();

-- Fix what is already there. Only rows the rule actually changes are touched.
UPDATE users
   SET first_name = normalize_person_name(first_name),
       last_name  = normalize_person_name(last_name)
 WHERE first_name IS DISTINCT FROM normalize_person_name(first_name)
    OR last_name  IS DISTINCT FROM normalize_person_name(last_name);
