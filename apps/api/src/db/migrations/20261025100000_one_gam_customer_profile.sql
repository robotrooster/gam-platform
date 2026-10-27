-- 10/25 (Nic) — ONE GAM CUSTOMER PROFILE PER PERSON, PLATFORM-WIDE.
--
--   "Each customer has one GAM customer account, so we can see everywhere that
--    they interact with GAM. My mechanic uses GAM for invoices and quotes. My
--    little grocery store uses it for inventory and point of sale. And customers
--    that live here, that use that mechanic, that go to that grocery store,
--    they're just automatically a customer at all three based on phone number
--    match... anywhere that person pops up in GAM, it is one GAM account."
--
-- THE MATCH RULE (Nic): "It has to have at least three matching data points of
-- information. It could be first name, last name, and phone number, or email,
-- and it could be a payment method saved on file."
--
-- So a person is the same person when THREE of these agree — first name, last
-- name, phone, email, a saved payment method — and never on fewer. Two points
-- is how you merge strangers: "Mike Smith" plus a shared area code is not a
-- person. The rule itself lives in packages/shared (customerMatch.ts) so the
-- importer, the register lookup and the business portal all count points the
-- same way; this table only records the answer.
--
-- A PROFILE IS NOT A LOGIN. GAM already has users for that. Most of these
-- people will never have an account they sign into — the 749 register customers
-- here are overwhelmingly somebody who bought propane once. The profile is who
-- they are; a login, when they ever want one, hangs off it.
--
-- WHAT CROSSES AND WHAT DOES NOT. The profile carries only what identifies a
-- person: their name, phone and email. It carries no balance, no lease, no
-- payment history and no card. Each business still keeps its own record of its
-- own dealings, linked to the profile — so the mechanic learns that this is the
-- same Dominic the park knows, and learns nothing else about him.
--
-- Deliberately NOT here yet: using a saved payment method at another GAM
-- business. Nic: "me just giving out somebody's phone number and using their
-- card to pay doesn't work... the person's account will have to have some other
-- sort of protection on there." That protection is undesigned, so the card
-- stays where it was taken.
--
-- Expand-only and re-runnable. Nothing is linked by this migration; the
-- backfill is its own reviewed step.

CREATE TABLE IF NOT EXISTS customer_profiles (
  id          uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  -- The identifying points, normalized by packages/shared customerMatch.
  first_name  text NOT NULL,
  last_name   text NOT NULL,
  phone       text,          -- digits only, no country prefix
  email       text,          -- lower-cased, trimmed
  -- 10/25 (Nic): phones change. "It'll have to be able to be edited on that."
  -- The repair and merge flows come later; these two make the record honest in
  -- the meantime — who last changed the identifying points, and when.
  points_changed_at timestamptz,
  points_changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE customer_profiles IS
  'One GAM customer per person, across every business on the platform (Nic,
   10/25). Identity only — name, phone, email. No balance, no lease, no payment
   history, no card. NOT a login: users is that. Matched on three agreeing data
   points (packages/shared customerMatch).';

CREATE INDEX IF NOT EXISTS idx_customer_profiles_phone ON customer_profiles (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_profiles_email ON customer_profiles (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_profiles_name  ON customer_profiles (lower(last_name), lower(first_name));

-- Every place in GAM this person turns up. One row per appearance, so
-- "anywhere that person pops up in GAM" is a single read.
CREATE TABLE IF NOT EXISTS customer_profile_links (
  id          uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
  -- Which world the row lives in. One definition in packages/shared
  -- (CUSTOMER_LINK_KINDS); the CHECK below lists the same values.
  kind        text NOT NULL,
  -- The row in that world (pos_customers.id, tenants.id, business_customers.id).
  ref_id      uuid NOT NULL,
  -- Who holds that record, for scoping reads. Exactly one of these is set.
  landlord_id uuid REFERENCES landlords(id) ON DELETE CASCADE,
  business_id uuid,
  -- What actually agreed, and how many points (>= 3), so a wrong link can be
  -- understood later instead of guessed at.
  matched_on  jsonb NOT NULL DEFAULT '[]'::jsonb,
  points      integer NOT NULL,
  -- A person GAM could not be sure about is left for a human rather than
  -- merged on a hunch (gam-left-owing-matching: "unsure → GAM admin").
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_profile_links_kind_check
    CHECK (kind IN ('tenant', 'pos_customer', 'business_customer')),
  CONSTRAINT customer_profile_links_points_check CHECK (points >= 3),
  CONSTRAINT customer_profile_links_one_holder
    CHECK ((landlord_id IS NOT NULL) <> (business_id IS NOT NULL))
);

COMMENT ON TABLE customer_profile_links IS
  'Every place a GAM customer turns up: a resident row, a register customer, a
   service-business customer. One row per appearance, so "anywhere that person
   pops up in GAM" is one read. points/matched_on record WHY it was linked.';

-- A given row in a given world belongs to exactly one profile.
CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_profile_links_ref
  ON customer_profile_links (kind, ref_id);

CREATE INDEX IF NOT EXISTS idx_customer_profile_links_profile
  ON customer_profile_links (profile_id);
