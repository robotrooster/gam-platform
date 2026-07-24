-- S550 gap 4: DEMO DATA was polluting the growth analytics — the geo and
-- platform-total snapshot rows mixed james@demo.dev's walkthrough
-- properties into "where we're growing." A buyer's diligence team finding
-- demo units inside the growth curve poisons the whole dataset's
-- credibility. Flag demo landlords; the snapshot queries exclude them
-- (services/growthSnapshots.ts). Property-grain rows keep everything
-- (attributable via landlord_id; filter at query time).
-- Backfill: james@demo.dev marked demo. Nic flags any others via SQL/admin.

ALTER TABLE landlords ADD COLUMN is_demo boolean NOT NULL DEFAULT false;

UPDATE landlords SET is_demo = TRUE
 WHERE user_id IN (SELECT id FROM users WHERE email = 'james@demo.dev');
