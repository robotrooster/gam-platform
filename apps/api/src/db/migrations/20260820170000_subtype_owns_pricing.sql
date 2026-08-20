-- S613 (Nic, DIRECTIVE): PRICE LIVES ON THE SUBTYPE. The unit inherits it.
--
-- "Why are we setting prices on subtype and the actual unit? What's the
--  difference? We shouldn't have it in both places... only set them on
--  subtypes, and then the landlord has to make a subtype for each unit to get
--  the price that's needed for any pricing variations."
--
-- He is right, and it was worse than redundant — it was ambiguous. A booking
-- quote preferred the SUBTYPE's nightly rate over the unit's; the renter-pool
-- match preferred the UNIT's rent over the subtype's. Opposite rules in two
-- files, so nobody could predict which number a guest would see. And editing a
-- subtype's price moved nothing: raise "Back-in 50 amp" to $480 and not one
-- 50-amp back-in followed, which is not what a class means.
--
-- WHY THIS IS SAFE TO COLLAPSE: units.rent_amount never charged anybody. A
-- long-term tenant is billed from leases.rent_amount (the lease is law) and a
-- deposit from its security_deposits row. The unit's price is the ASKING price
-- — it prefills a lease draft, shows on a listing, feeds rent-volume, and
-- prices short stays (a reservation has no lease). So the grandfathered tenant
-- at $380 under a $440 class keeps paying $380: his lease says so.
--
-- BACKFILL RULE: nobody's numbers move today. A subtype is minted for every
-- DISTINCT price set that currently exists, grouped with the physical facts so
-- applying a class never rewrites a unit's facts either. Oak Park's 30 units
-- collapse to four classes. Consolidating further is the landlord's call, made
-- by hand, afterwards.

-- ── 1. Adopt the landlord's OWN classes first ──────────────────────────
--
-- Before minting anything, point units at a subtype the landlord already
-- built, where its prices are identical and its facts don't contradict. A
-- class that says nothing about bedrooms is compatible with any bedroom count
-- — Nic's "Tenant Owned" describes his eight mobile homes even though he never
-- typed a bed count into it. Minting a near-duplicate beside a class he made
-- himself is exactly the clutter this whole change is meant to remove.
--
-- Prices must match EXACTLY, nulls included. A class that carries a monthly
-- stay rate the unit doesn't have is not the same deal, and adopting it would
-- change what a guest is quoted — the one thing this migration must never do.
WITH candidate AS (
  SELECT u.id AS unit_id, s.id AS subtype_id,
         row_number() OVER (PARTITION BY u.id ORDER BY s.created_at, s.id) AS pick
    FROM units u
    JOIN property_unit_subtypes s
      ON s.property_id = u.property_id AND s.unit_type = u.unit_type
   WHERE u.retired_at IS NULL AND u.subtype_id IS NULL
     AND s.rent_amount      IS NOT DISTINCT FROM u.rent_amount
     AND s.security_deposit IS NOT DISTINCT FROM u.security_deposit
     AND s.nightly_rate     IS NOT DISTINCT FROM (CASE WHEN u.unit_type = 'rv_spot' THEN u.nightly_rate END)
     AND s.weekly_rate      IS NOT DISTINCT FROM (CASE WHEN u.unit_type = 'rv_spot' THEN u.weekly_rate  END)
     AND s.monthly_rate     IS NOT DISTINCT FROM (CASE WHEN u.unit_type = 'rv_spot' THEN u.monthly_rate END)
     -- facts: null on the class is a wildcard, anything else must agree
     AND (s.bedrooms       IS NULL OR s.bedrooms       IS NOT DISTINCT FROM u.bedrooms)
     AND (s.bathrooms      IS NULL OR s.bathrooms      IS NOT DISTINCT FROM u.bathrooms)
     AND (s.rv_site_layout IS NULL OR s.rv_site_layout IS NOT DISTINCT FROM NULLIF(u.rv_site_layout,'none'))
     AND (s.rv_amp_service IS NULL OR s.rv_amp_service IS NOT DISTINCT FROM NULLIF(u.rv_amp_service,'none'))
     AND (s.storage_size   IS NULL OR s.storage_size   IS NOT DISTINCT FROM NULLIF(btrim(u.storage_size),''))
     AND (s.dwelling_ownership IS NULL OR s.dwelling_ownership IS NOT DISTINCT FROM u.dwelling_ownership)
)
UPDATE units u SET subtype_id = c.subtype_id, updated_at = NOW()
  FROM candidate c WHERE c.unit_id = u.id AND c.pick = 1;

-- ── 2. Mint a class for every price set still unaccounted for ──────────
CREATE TEMP TABLE _needs_subtype ON COMMIT DROP AS
SELECT
  u.property_id,
  u.unit_type,
  CASE WHEN u.unit_type IN ('apartment','single_family','mobile_home') THEN u.bedrooms END       AS bedrooms,
  CASE WHEN u.unit_type IN ('apartment','single_family','mobile_home') THEN u.bathrooms END      AS bathrooms,
  CASE WHEN u.unit_type = 'rv_spot' THEN NULLIF(u.rv_site_layout, 'none') END                    AS rv_site_layout,
  CASE WHEN u.unit_type = 'rv_spot' THEN NULLIF(u.rv_amp_service, 'none') END                    AS rv_amp_service,
  CASE WHEN u.unit_type = 'storage' THEN NULLIF(btrim(u.storage_size), '') END                   AS storage_size,
  CASE WHEN u.unit_type IN ('rv_spot','mobile_home') THEN u.dwelling_ownership END               AS dwelling_ownership,
  u.rent_amount,
  u.security_deposit,
  CASE WHEN u.unit_type = 'rv_spot' THEN u.nightly_rate END                                      AS nightly_rate,
  CASE WHEN u.unit_type = 'rv_spot' THEN u.weekly_rate  END                                      AS weekly_rate,
  CASE WHEN u.unit_type = 'rv_spot' THEN u.monthly_rate END                                      AS monthly_rate
FROM units u
LEFT JOIN property_unit_subtypes s ON s.id = u.subtype_id
WHERE u.retired_at IS NULL
  AND (
    s.id IS NULL
    OR s.rent_amount      IS DISTINCT FROM u.rent_amount
    OR s.security_deposit IS DISTINCT FROM u.security_deposit
    OR (u.unit_type = 'rv_spot' AND (
         s.nightly_rate IS DISTINCT FROM u.nightly_rate
      OR s.weekly_rate  IS DISTINCT FROM u.weekly_rate
      OR s.monthly_rate IS DISTINCT FROM u.monthly_rate))
  )
GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13;

-- Names come from the facts the landlord would recognise ("Back-in 50 amp",
-- "2 bed 1 bath", "10x10"). Where two classes share those facts, the tail names
-- the money that ACTUALLY differs between them — Oak Park's two back-in blocks
-- are the same rent and differ only by deposit, so tailing them with the rent
-- would have produced two identically-named classes and told him nothing.
CREATE TEMP TABLE _final ON COMMIT DROP AS
WITH money AS (
  SELECT n.*,
    NULLIF(btrim(concat_ws(' ',
      CASE WHEN n.bedrooms = 0 THEN 'Studio'
           WHEN n.bedrooms IS NOT NULL THEN n.bedrooms || ' bed' END,
      CASE WHEN n.bathrooms IS NOT NULL THEN trim(trailing '.' from trim(trailing '0' from n.bathrooms::text)) || ' bath' END,
      CASE n.rv_site_layout WHEN 'pull_through' THEN 'Pull-through' WHEN 'back_in' THEN 'Back-in' END,
      CASE WHEN n.rv_amp_service = 'both' THEN '30/50 amp'
           WHEN n.rv_amp_service IS NOT NULL THEN n.rv_amp_service || ' amp' END,
      n.storage_size)), '') AS base
  FROM _needs_subtype n
), spread AS (
  SELECT m.*, COALESCE(m.base, 'Standard') AS plain,
    count(*)          OVER w AS share,
    min(m.rent_amount)      OVER w AS rent_lo,  max(m.rent_amount)      OVER w AS rent_hi,
    min(m.security_deposit) OVER w AS dep_lo,   max(m.security_deposit) OVER w AS dep_hi,
    min(m.nightly_rate)     OVER w AS night_lo, max(m.nightly_rate)     OVER w AS night_hi
  FROM money m
  WINDOW w AS (PARTITION BY m.property_id, m.unit_type, COALESCE(m.base, 'Standard'))
), tailed AS (
  SELECT s.*,
    CASE
      WHEN s.share = 1 THEN s.plain
      WHEN s.rent_lo IS DISTINCT FROM s.rent_hi
        THEN s.plain || ' $' || trim(trailing '.' from trim(trailing '0' from s.rent_amount::text))
      WHEN s.dep_lo IS DISTINCT FROM s.dep_hi
        THEN s.plain || CASE WHEN s.security_deposit = 0 THEN ' no deposit'
                             ELSE ' deposit $' || trim(trailing '.' from trim(trailing '0' from s.security_deposit::text)) END
      WHEN s.night_lo IS DISTINCT FROM s.night_hi
        THEN s.plain || ' $' || trim(trailing '.' from trim(trailing '0' from s.nightly_rate::text)) || '/night'
      ELSE s.plain
    END AS want_name
  FROM spread s
), ranked AS (
  SELECT t.*,
    row_number() OVER (PARTITION BY t.property_id, t.unit_type, lower(t.want_name)
                       ORDER BY t.rent_amount, t.security_deposit) AS dup_n,
    EXISTS (SELECT 1 FROM property_unit_subtypes s
             WHERE s.property_id = t.property_id AND s.unit_type = t.unit_type
               AND lower(btrim(s.name)) = lower(btrim(t.want_name))) AS taken
  FROM tailed t
)
-- Anything still colliding gets a numeric tail. Rare, but a silent overwrite is
-- the bug this session started with, so it cannot be left to chance.
SELECT r.*,
  CASE WHEN r.dup_n > 1 OR r.taken
       THEN left(r.want_name, 50) || ' (' || (r.dup_n + CASE WHEN r.taken THEN 1 ELSE 0 END) || ')'
       ELSE r.want_name END AS final_name
FROM ranked r;

INSERT INTO property_unit_subtypes
  (property_id, unit_type, name, bedrooms, bathrooms, rv_site_layout, rv_amp_service,
   storage_size, dwelling_ownership, rent_amount, security_deposit,
   nightly_rate, weekly_rate, monthly_rate)
SELECT property_id, unit_type, final_name, bedrooms, bathrooms, rv_site_layout, rv_amp_service,
       storage_size, dwelling_ownership, rent_amount, security_deposit,
       nightly_rate, weekly_rate, monthly_rate
FROM _final
ON CONFLICT (property_id, unit_type, name) DO NOTHING;

UPDATE units u
   SET subtype_id = s.id, updated_at = NOW()
  FROM _final f
  JOIN property_unit_subtypes s
    ON s.property_id = f.property_id AND s.unit_type = f.unit_type AND s.name = f.final_name
 WHERE u.retired_at IS NULL
   AND u.property_id = f.property_id
   AND u.unit_type   = f.unit_type
   AND u.rent_amount      IS NOT DISTINCT FROM f.rent_amount
   AND u.security_deposit IS NOT DISTINCT FROM f.security_deposit
   AND (u.unit_type <> 'rv_spot' OR (
        u.nightly_rate IS NOT DISTINCT FROM f.nightly_rate
    AND u.weekly_rate  IS NOT DISTINCT FROM f.weekly_rate
    AND u.monthly_rate IS NOT DISTINCT FROM f.monthly_rate))
   AND (u.unit_type NOT IN ('apartment','single_family','mobile_home') OR (
        u.bedrooms  IS NOT DISTINCT FROM f.bedrooms
    AND u.bathrooms IS NOT DISTINCT FROM f.bathrooms))
   AND (u.unit_type <> 'rv_spot' OR (
        NULLIF(u.rv_site_layout,'none') IS NOT DISTINCT FROM f.rv_site_layout
    AND NULLIF(u.rv_amp_service,'none') IS NOT DISTINCT FROM f.rv_amp_service))
   AND (u.unit_type <> 'storage' OR NULLIF(btrim(u.storage_size),'') IS NOT DISTINCT FROM f.storage_size)
   AND (u.unit_type NOT IN ('rv_spot','mobile_home')
        OR u.dwelling_ownership IS NOT DISTINCT FROM f.dwelling_ownership);

-- ── 3. The class price now REACHES its units ───────────────────────────
--
-- This is the behaviour Nic expected and did not have: raise the class, every
-- unit in it follows. A trigger rather than route code because units are
-- created and edited from several doors (Add Unit, onboarding, the importer,
-- retire-and-replace) and a rule enforced in one of them is a rule that holds
-- until someone uses a different door.
--
-- Retired units are excluded: a retired record keeps the numbers it was retired
-- with, the same posture as everything else about a retired unit.
CREATE OR REPLACE FUNCTION propagate_subtype_pricing() RETURNS trigger AS $$
BEGIN
  IF NEW.rent_amount      IS DISTINCT FROM OLD.rent_amount
  OR NEW.security_deposit IS DISTINCT FROM OLD.security_deposit
  OR NEW.nightly_rate     IS DISTINCT FROM OLD.nightly_rate
  OR NEW.weekly_rate      IS DISTINCT FROM OLD.weekly_rate
  OR NEW.monthly_rate     IS DISTINCT FROM OLD.monthly_rate THEN
    UPDATE units u SET
      -- rent_amount is NOT NULL on units; a class that clears its rent leaves
      -- the last known number rather than failing the landlord's save.
      rent_amount      = COALESCE(NEW.rent_amount, u.rent_amount),
      security_deposit = COALESCE(NEW.security_deposit, 0),
      nightly_rate     = NEW.nightly_rate,
      weekly_rate      = NEW.weekly_rate,
      monthly_rate     = NEW.monthly_rate,
      updated_at       = NOW()
     WHERE u.subtype_id = NEW.id AND u.retired_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_propagate_subtype_pricing ON property_unit_subtypes;
CREATE TRIGGER trg_propagate_subtype_pricing
  AFTER UPDATE ON property_unit_subtypes
  FOR EACH ROW EXECUTE FUNCTION propagate_subtype_pricing();
