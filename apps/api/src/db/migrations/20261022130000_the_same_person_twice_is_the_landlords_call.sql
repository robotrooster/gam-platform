-- 10/20 (Nic) — THE SAME PERSON, TWICE, AND ONLY THE LANDLORD MAY SAY SO.
--
--   "for merging two people, bring it up to the landlord. Say, hey, this looks
--    like the same person. They have the same name. Same email, or maybe the
--    email's different, but the phone number's the same. Or maybe the phone
--    number is off by like 1. Maybe it's a typo. There's a lot of ways to kind
--    of clarify that. But have it be always have the landlord check that the
--    customer is the same."
--
-- WHY THIS EXISTS NOW. The old schedule has just come in from a file and the
-- texted reservations are being typed in behind it (services/reservationImport),
-- so the same guest is on the board twice by Friday: once as the file spelled
-- him, once as Nic typed him off a phone screen. Nobody notices until he turns
-- up, and by then GAM has treated two halves of one man as two strangers — two
-- balances, two stay chains, a background check run on a man who has wintered
-- here for six years.
--
-- TWO TABLES, AND THE SPLIT BETWEEN THEM IS THE WHOLE DESIGN:
--
--   duplicate_person_proposals — what GAM NOTICED. Written by a matcher, read
--     by a landlord, and worth nothing on its own. Every row is a question.
--   person_merges — what the LANDLORD DECIDED. One row per person folded into
--     another, with who decided it and exactly what moved.
--
-- Nothing merges anybody. A proposal is a question and the answer is a person's
-- (routes/duplicatePeople); there is no job, no threshold and no "high
-- confidence auto-merge" anywhere, because the cost of being wrong is two
-- people's rent history in one pile and no honest way back out.
--
-- AND NOTHING HERE ERASES A RECORD. A merge keeps both rows and points them at
-- one person — the technique GAM already uses on duplicate accounts, which is
-- to MOVE THE SIGN-IN ADDRESS rather than migrate a lease: tenants(id) is
-- referenced by 56 tables and lease_document_signers.user_id binds an executed
-- lease to the person who signed it, so moving a lease to another user id
-- detaches a signed document from its signer. Renaming does not.
--
-- NO BACKFILL. Both tables start empty; the first scan fills the first one.

-- ── WHAT GAM NOTICED ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS duplicate_person_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The company the pair was raised under. Reads scope to every company the
  -- ACCOUNT owns (lib/landlordScope landlordScopeIds), which is also how the
  -- candidates were gathered — a landlord who runs two parks has one book of
  -- people, and one person can be in both. Never across accounts: Nic must
  -- never be shown Blu's guests, and a merge may only touch rows inside the
  -- account that asked for it.
  landlord_id   uuid NOT NULL REFERENCES landlords(id),

  -- THE PAIR, CANONICALLY. 'u:<user uuid>' for somebody with a sign-in,
  -- 'g:<booking uuid>' for a reservation guest who has none — the uuid being
  -- that guest's EARLIEST reservation, which is the one handle that does not
  -- move when a later merge fills in an address. The two are sorted before
  -- they are stored, so A-and-B and B-and-A are one row and one answer.
  pair_key      text NOT NULL,

  side_a_kind       text NOT NULL,
  side_a_user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  side_a_booking_id uuid REFERENCES unit_bookings(id) ON DELETE CASCADE,
  side_b_kind       text NOT NULL,
  side_b_user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  side_b_booking_id uuid REFERENCES unit_bookings(id) ON DELETE CASCADE,

  -- WHAT MADE US ASK, in the five words @gam/shared DUPLICATE_SIGNALS allows,
  -- so the screen can print a sentence per signal instead of a score nobody
  -- can argue with.
  signals       text[] NOT NULL DEFAULT '{}',
  confidence    text   NOT NULL,
  score         integer NOT NULL DEFAULT 0,

  status        text NOT NULL DEFAULT 'open',

  -- The two people as they read at the last scan: names, addresses, phones and
  -- how much history each side has. Kept so a decided proposal still says who
  -- it was about months later, when the identities behind it have moved on.
  snapshot      jsonb,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),

  -- THE ANSWER. decided_at is set by a person, always, and a decided row is
  -- never reopened by a scan — a dismissal that comes back next week is how a
  -- list becomes noise nobody reads.
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  keeper_side   text,
  merge_outcome jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A side is one kind of thing and names exactly the one row of it. A
  -- proposal that names both, or neither, is a row nobody can act on.
  CONSTRAINT dpp_side_a_shape CHECK (
    (side_a_kind = 'account' AND side_a_user_id IS NOT NULL AND side_a_booking_id IS NULL)
    OR (side_a_kind = 'guest' AND side_a_booking_id IS NOT NULL AND side_a_user_id IS NULL)),
  CONSTRAINT dpp_side_b_shape CHECK (
    (side_b_kind = 'account' AND side_b_user_id IS NOT NULL AND side_b_booking_id IS NULL)
    OR (side_b_kind = 'guest' AND side_b_booking_id IS NOT NULL AND side_b_user_id IS NULL)),
  CONSTRAINT dpp_sides_differ CHECK (
    side_a_user_id IS DISTINCT FROM side_b_user_id
    OR side_a_booking_id IS DISTINCT FROM side_b_booking_id),
  CONSTRAINT dpp_confidence_check CHECK (confidence IN ('strong', 'likely', 'possible')),
  CONSTRAINT dpp_status_check CHECK (status IN ('open', 'merged', 'not_duplicate')),
  CONSTRAINT dpp_keeper_side_check CHECK (keeper_side IS NULL OR keeper_side IN ('a', 'b')),
  -- An answer has a hand on it. Both or neither.
  CONSTRAINT dpp_decided_shape CHECK ((status = 'open') = (decided_at IS NULL))
);

-- ONE QUESTION PER PAIR, FOREVER. This index is what makes a dismissal stick:
-- the scan upserts against it, so the pair Nic has already answered is found
-- rather than asked again.
CREATE UNIQUE INDEX IF NOT EXISTS duplicate_person_proposals_pair_idx
  ON duplicate_person_proposals (landlord_id, pair_key);

-- The screen's own query: this account's open questions, worst first.
CREATE INDEX IF NOT EXISTS duplicate_person_proposals_open_idx
  ON duplicate_person_proposals (landlord_id, status, score DESC);

DROP TRIGGER IF EXISTS audit_duplicate_person_proposals ON duplicate_person_proposals;
CREATE TRIGGER audit_duplicate_person_proposals
  AFTER DELETE OR UPDATE ON duplicate_person_proposals
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

DROP TRIGGER IF EXISTS set_updated_at_duplicate_person_proposals ON duplicate_person_proposals;
CREATE TRIGGER set_updated_at_duplicate_person_proposals
  BEFORE UPDATE ON duplicate_person_proposals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE duplicate_person_proposals IS
  '10/20 (Nic): "this looks like the same person... but have it be always have the landlord check that the customer is the same." A question GAM raises and a person answers. Nothing here merges anybody.';
COMMENT ON COLUMN duplicate_person_proposals.pair_key IS
  'The two identities, sorted: u:<user uuid> for an account, g:<earliest booking uuid> for a reservation guest. Unique per company — this is what makes a dismissal stick.';
COMMENT ON COLUMN duplicate_person_proposals.signals IS
  'What made us ask (@gam/shared DUPLICATE_SIGNALS). Same name alone is never one of the reasons a row exists: two Smiths at an RV park are two people.';
COMMENT ON COLUMN duplicate_person_proposals.snapshot IS
  'Both people as they read at the last scan, so a decided proposal can still say who it was about.';

-- ── WHAT THE LANDLORD DECIDED ───────────────────────────────────────────────
--
-- One row per person folded into another. It is the record of a human decision
-- and it is also load-bearing: the matcher reads it to resolve each identity to
-- the person it was merged into, so a pair that has been answered is never
-- raised a second time under a slightly different shape.
CREATE TABLE IF NOT EXISTS person_merges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id   uuid NOT NULL REFERENCES landlords(id),
  proposal_id   uuid REFERENCES duplicate_person_proposals(id) ON DELETE SET NULL,

  -- The identity that SURVIVES, and the one folded into it. Same two forms as
  -- pair_key above, stored as keys so the matcher can resolve a whole account's
  -- merges in one read.
  keeper_key    text NOT NULL,
  keeper_kind   text NOT NULL,
  keeper_user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  keeper_booking_id uuid REFERENCES unit_bookings(id) ON DELETE CASCADE,
  loser_key     text NOT NULL,
  loser_kind    text NOT NULL,
  loser_user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  loser_booking_id  uuid REFERENCES unit_bookings(id) ON DELETE CASCADE,

  -- WHAT ACTUALLY MOVED, so the landlord can be told in plain words and so a
  -- later session can see it without re-deriving anything.
  --   email_moved  — the sign-in address lifted onto the surviving account
  --   email_retired_to — the duplicate-<id>@invalid name the folded account
  --                      now answers to (RFC 2606: it can never receive mail)
  --   reservations_repointed — bookings now pointing at the surviving person
  --   emails_filled — reservations that had NO address and now carry the
  --                   person's, which is what lets the stay chain see one guest
  email_moved          text,
  email_retired_to     text,
  reservations_repointed integer NOT NULL DEFAULT 0,
  emails_filled          integer NOT NULL DEFAULT 0,
  detail        jsonb,

  merged_at     timestamptz NOT NULL DEFAULT now(),
  merged_by     uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT pm_keeper_shape CHECK (
    (keeper_kind = 'account' AND keeper_user_id IS NOT NULL AND keeper_booking_id IS NULL)
    OR (keeper_kind = 'guest' AND keeper_booking_id IS NOT NULL AND keeper_user_id IS NULL)),
  CONSTRAINT pm_loser_shape CHECK (
    (loser_kind = 'account' AND loser_user_id IS NOT NULL AND loser_booking_id IS NULL)
    OR (loser_kind = 'guest' AND loser_booking_id IS NOT NULL AND loser_user_id IS NULL)),
  CONSTRAINT pm_sides_differ CHECK (keeper_key <> loser_key)
);

-- A PERSON IS FOLDED IN ONCE. Two merges naming the same loser would be two
-- answers to one question, and the second one silently wins.
CREATE UNIQUE INDEX IF NOT EXISTS person_merges_loser_idx
  ON person_merges (landlord_id, loser_key);

CREATE INDEX IF NOT EXISTS person_merges_keeper_idx
  ON person_merges (landlord_id, keeper_key);

DROP TRIGGER IF EXISTS audit_person_merges ON person_merges;
CREATE TRIGGER audit_person_merges
  AFTER DELETE OR UPDATE ON person_merges
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE person_merges IS
  '10/20 (Nic): one row per person the landlord said was already in the book. A merge keeps BOTH records and points them at one person — GAM never erases. The matcher reads this so an answered pair is never asked again.';
COMMENT ON COLUMN person_merges.email_retired_to IS
  'The duplicate-<id>@invalid address the folded account now answers to (RFC 2606 — can never receive mail). The row itself stays, and stays findable by name and phone.';
COMMENT ON COLUMN person_merges.emails_filled IS
  'Reservations that carried NO email and now carry the person''s. The stay chain matches on tenant_id OR guest_email (services/stayTerms), so this is what makes two halves of one guest read as one.';

-- ── THE STAMP ON A FOLDED RESERVATION ───────────────────────────────────────
--
-- A reservation guest's identity IS their name, address and phone as written on
-- the booking — there is no person row behind them. So when a merge fills in the
-- address that was missing, that identity's own shape changes, and anything that
-- recognized them by it would see somebody new next Friday and ask Nic the same
-- question again.
--
-- This is how a folded reservation stays folded: the matcher skips any booking
-- carrying a stamp (services/duplicatePeople gatherPeople), so the guest who was
-- joined to somebody is gone from the list for good. It also puts the reason on
-- the row itself — why this reservation's email changed on a Tuesday in October
-- is answerable without reading the change journal.
--
-- NO BACKFILL. NULL on every row today means what it says: this reservation has
-- never been folded into anybody.
ALTER TABLE unit_bookings
  ADD COLUMN IF NOT EXISTS folded_into_person_merge_id uuid
    REFERENCES person_merges(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS unit_bookings_folded_person_idx
  ON unit_bookings (folded_into_person_merge_id)
  WHERE folded_into_person_merge_id IS NOT NULL;

COMMENT ON COLUMN unit_bookings.folded_into_person_merge_id IS
  '10/20 (Nic): the landlord said this reservation''s guest is somebody already in the book (person_merges). The row stays on the board exactly as booked; the matcher stops asking about it.';
