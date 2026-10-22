-- 10/20–21 (Nic) — WHEN SOMEBODY LEAVES OWING, THE NEXT LANDLORD GETS A FLAG.
--
--   "if somebody leaves us owing money, another landlord can see that. They
--    just can't see specifics. They can't see an exact dollar amount. They
--    can't see who the other landlord was. They can't see when it happened, but
--    they can just be flagged as high risk, owes other people money. They need
--    to settle up."
--
-- WHAT THIS TABLE IS NOT. It is not the "moved out, still owes" folder — that
-- is derived live from leases and stays, belongs to ONE landlord, and carries
-- every figure. This is the opposite: a deliberately thin record, written down
-- so a DIFFERENT landlord can be told that something exists without being told
-- what it is.
--
-- WHY IT IS STORED AT ALL, when the folder can be computed. Because the
-- question another landlord asks is "has this person done this anywhere", and
-- answering it live would mean reading every landlord's books on every
-- application. A person's debts are not something to go scanning for; a flag
-- they left behind is something to look up.
--
-- WHO IT IS ABOUT, AND THE ONE RULE THAT MATTERS MOST (Claude's call, 10/21,
-- for Nic to counter): a flag is matched to a new applicant ONLY through a
-- verified GAM account — the same user, or the same address on an account whose
-- email is verified. Never a name, never a name and a phone number. Two people
-- share a name; one person mistyped is told, in front of a landlord deciding
-- whether to house them, that they are high risk and owe money. A missed flag
-- costs a landlord money. A false one costs somebody a home, and there is no
-- undo for it. So the match is narrow on purpose, and `user_id` is the join —
-- `email` and `who` are kept only so a human can recognise the row.
--
-- NOTHING IN HERE CROSSES LANDLORDS BY ITSELF. The amount, the landlord who was
-- owed and the dates are all stored, and NONE of them is served to anybody but
-- the landlord who is owed, until a reveal is paid for by the person asking
-- (the two doors, below). The flag another landlord sees is three words.
CREATE TABLE IF NOT EXISTS tenant_left_owing (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Who is owed, and where it happened. The property is what makes a step-one
  -- reveal possible ("August of 2024 in Las Vegas") without naming anybody.
  landlord_id     uuid NOT NULL REFERENCES landlords(id),
  property_id     uuid REFERENCES properties(id),

  -- Who owes. user_id is the ONLY thing a cross-landlord match is made on.
  user_id         uuid REFERENCES users(id),
  email           text,
  who             text,

  -- What the folder said when they left. Never served across landlords unless
  -- the second door is opened.
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  -- The lease or stay it came from, so the row can be traced back and so a
  -- second sweep updates this row instead of writing another.
  source_kind     text NOT NULL CHECK (source_kind IN ('lease', 'stay')),
  source_key      text NOT NULL,
  -- 'YYYY-MM-DD': the day they left.
  left_on         date,

  -- Settled, waived, or paid off since. A flag is a live fact, not a record of
  -- somebody's worst month: once the money is square the flag goes. The ROW
  -- stays (GAM erases nothing) — it is `settled_at` that silences it.
  settled_at      timestamptz,
  settled_reason  text,

  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),

  -- One row per thing they walked away from, so a nightly sweep is idempotent.
  CONSTRAINT tenant_left_owing_source_uniq UNIQUE (landlord_id, source_kind, source_key)
);

-- The question this table exists to answer, asked by user id and by nothing else.
CREATE INDEX IF NOT EXISTS idx_tenant_left_owing_person
  ON tenant_left_owing (user_id) WHERE settled_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_left_owing_landlord
  ON tenant_left_owing (landlord_id, settled_at);

COMMENT ON TABLE tenant_left_owing IS
  'A debt somebody walked away from, kept so a DIFFERENT landlord can be told it exists without being told what it is (10/20-21, Nic). Matched to an applicant only through a verified GAM account — never a name.';

-- ── THE TWO DOORS (10/21) ───────────────────────────────────────────────────
--
--   "we need a two-step thing. We need to first probably reveal some details
--    about where the debt occurred, because the person at the front counter may
--    not remember who they owed, when and where, whatever."
--
--   STEP 1, free: the month and the place. "August of 2024 in Las Vegas." No
--   amount, nobody named. It obligates nobody — it is there to jog the
--   applicant's memory so they can say "oh, that one" and settle it.
--
--   STEP 2, which BUYS THE DEBT: "only click this box if the tenant's willing
--   to pay for it, because the money, they can pay you and we'll collect the
--   money from you. But if you click on this and they don't pay, we're
--   collecting that debt from you... Only open it if you're ready to freaking
--   rock and roll."
--
-- Every opening of either door is written down here, because a landlord who
-- opened the second one has taken on somebody else's debt and that is not a
-- thing to be remembered differently by the two parties later.
--
-- STEP TWO IS NOT BUILT YET, on purpose: it moves money a new way (one
-- landlord assuming another's debt, GAM collecting it from them) and that is
-- Nic's to approve before it exists. The column is here so the first door is
-- not rebuilt when the second one lands.
CREATE TABLE IF NOT EXISTS tenant_left_owing_reveals (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  owing_id      uuid NOT NULL REFERENCES tenant_left_owing(id),
  -- The landlord who looked, and the person who pressed it.
  landlord_id   uuid NOT NULL REFERENCES landlords(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  -- 'where_and_when' is free. 'the_total' takes the debt on.
  door          text NOT NULL CHECK (door IN ('where_and_when', 'the_total')),
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  -- The first door may be opened once per landlord per debt and no more; the
  -- second, once ever, by whoever took it on.
  CONSTRAINT tenant_left_owing_reveal_once UNIQUE (owing_id, landlord_id, door)
);

COMMENT ON TABLE tenant_left_owing_reveals IS
  'Who opened which door on somebody else''s debt, and when. The second door means that landlord has assumed the debt (10/21, Nic) — never to be remembered differently by the two parties later.';
