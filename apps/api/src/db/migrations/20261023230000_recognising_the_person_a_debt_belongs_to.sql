-- 10/22 (Nic) — HOW SOMEBODY IS RECOGNISED, AND WHO DECIDES WHEN IT IS CLOSE.
--
-- He overruled the first cut the day it was written. It matched a verified GAM
-- account and nothing else:
--
--   "It's a flag only matches a verified GAM account. That's not right. It can
--    match based on multiple contact points... if there's a name match with an
--    email or name match with a phone number, that is going to be good enough
--    for us right now. I know people can change their email and phone number
--    and stuff, but most of the time they don't change both."
--
-- So a debt row has to be able to carry a PHONE — it is one of the two contact
-- points, and there was nowhere to put it. The names are already there (`who`),
-- and so is the email.
--
-- AND A THIRD ANSWER NEEDS SOMEWHERE TO LIVE. 10/22: "Maybe when there's a not
-- sure call, we can leave it to the admin to kind of do some research on." A
-- contact point that agrees with a name that only half agrees — an initial, a
-- brother at the same address, a surname that changed with a marriage — is
-- neither a match nor a miss. It waits here for a person at GAM, and until that
-- person decides, NOBODY IS FLAGGED. Never a silent guess in either direction.
--
-- WHERE THE BALANCES COME FROM. The onboarding import of a landlord's old
-- unpaid invoices (Square, mostly), which is the whole reason the flag exists —
-- so 'import' joins 'lease' and 'stay' as a source a debt can have. The amount
-- stays frozen at import either way; nothing here lets it move.
--
-- No backfill needed: phone is new and null everywhere, and the review table
-- starts empty. Both are additive.

ALTER TABLE tenant_left_owing ADD COLUMN IF NOT EXISTS phone TEXT;

COMMENT ON COLUMN tenant_left_owing.phone IS
  'The phone on the invoice this debt came from — one of the two contact points a person is recognised by (services/nameMatch).';

-- An imported invoice is a source in its own right.
ALTER TABLE tenant_left_owing DROP CONSTRAINT IF EXISTS tenant_left_owing_source_kind_check;
ALTER TABLE tenant_left_owing ADD CONSTRAINT tenant_left_owing_source_kind_check
  CHECK (source_kind IN ('lease', 'stay', 'import'));

-- The two contact points, compared the ONE way services/nameMatch compares
-- them: an email trimmed and lower-cased, a phone as its last ten digits. The
-- indexes carry the same expressions the matcher's WHERE clause uses, so a
-- park with ten thousand old invoices still answers a flag check in one seek.
CREATE INDEX IF NOT EXISTS idx_tenant_left_owing_email
  ON tenant_left_owing (lower(btrim(email)))
  WHERE settled_at IS NULL AND email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_left_owing_phone
  ON tenant_left_owing (right(regexp_replace(phone, '[^0-9]', '', 'g'), 10))
  WHERE settled_at IS NULL AND phone IS NOT NULL;

-- ── The admin's queue ───────────────────────────────────────────────────────
--
-- One row per (debt, person) pair that came up close. It is raised by the read
-- that noticed it, carries WHY it was not decided by rule, and holds the
-- person's answer when it comes.
--
-- `person_key` is what makes the pair unique when there is no account to point
-- at: the normalized email or phone the two were matched on. Without it an
-- applicant with no GAM account would raise a fresh row on every search.
CREATE TABLE IF NOT EXISTS tenant_left_owing_match_reviews (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owing_id       UUID NOT NULL REFERENCES tenant_left_owing(id),
  -- The person who was being checked, as they were typed at the time. Kept as
  -- typed on purpose: the reviewer needs to see what the clerk saw.
  user_id        UUID REFERENCES users(id),
  person_name    TEXT,
  person_email   TEXT,
  person_phone   TEXT,
  person_key     TEXT NOT NULL,
  -- Which contact point agreed, and how far the name got.
  matched_on     TEXT NOT NULL CHECK (matched_on IN ('email', 'phone', 'account')),
  name_agreement TEXT NOT NULL CHECK (name_agreement IN ('same', 'unsure', 'different')),
  why            TEXT NOT NULL,
  -- 'open' until somebody at GAM says. Nothing is flagged while it is open.
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'same_person', 'not_the_same_person')),
  decided_by     UUID REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  decided_note   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A decision is a person and a moment, together or not at all.
  CONSTRAINT left_owing_review_decided_shape
    CHECK ((status = 'open') = (decided_at IS NULL)),
  CONSTRAINT left_owing_review_one_per_pair UNIQUE (owing_id, person_key)
);

CREATE INDEX IF NOT EXISTS idx_left_owing_review_open
  ON tenant_left_owing_match_reviews (created_at)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_left_owing_review_person
  ON tenant_left_owing_match_reviews (person_key)
  WHERE status = 'same_person';

-- CLAUDE.md: the change journal is the only record of what a row said before
-- somebody changed it. A review decides whether a debt follows a person into
-- another park, which is as consequential as a figure.
DROP TRIGGER IF EXISTS audit_tenant_left_owing_match_reviews ON tenant_left_owing_match_reviews;
CREATE TRIGGER audit_tenant_left_owing_match_reviews
  AFTER UPDATE OR DELETE ON tenant_left_owing_match_reviews
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE tenant_left_owing_match_reviews IS
  '10/22 (Nic): "when there is a not sure call, we can leave it to the admin to do some research on". A contact point agreed but the name only half did; nobody is flagged until a person at GAM decides.';
