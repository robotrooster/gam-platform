-- S630 (Nic, DIRECTIVE): "Once I tagged it as thirty amp and fifty amp and then
-- deselected the fifty amp, the electrical service on the unit card still says
-- thirty and fifty. Things need to be actually reflecting the reality."
--
-- The previous version treated the unit's physical fields as separate from its
-- tags and merely OFFERED to reconcile them. That guarantees drift: the offer is
-- one click, untagging is another, and nothing links the two. A space could sit
-- there tagged 30 amp while its own card said 30/50, and every listing, quote and
-- report downstream reads the card.
--
-- The tags now DECIDE the physical facts. This is not a reversal of "a subtype
-- classifies, it never prices" (S629) — it is that rule taken seriously. A
-- subtype says what a space IS: back-in, 50 amp, two bedrooms. Money is the part
-- that stays per unit, and this function never touches rent, deposit or rates.
--
-- A tag that declares nothing decides nothing. "Riverfront" is a pure label, and
-- untagging never blanks a fact — removing a label is not a claim that the
-- pedestal lost its wiring.
CREATE OR REPLACE FUNCTION sync_unit_facts_from_subtypes(p_unit_id uuid) RETURNS void AS $$
DECLARE
  v_layouts   text[];
  v_amps      text[];
  v_beds      int[];
  v_baths     numeric[];
  v_sizes     text[];
  v_amp       text;
BEGIN
  SELECT array_agg(DISTINCT s.rv_site_layout) FILTER (WHERE s.rv_site_layout IS NOT NULL AND s.rv_site_layout <> 'none'),
         array_agg(DISTINCT s.bedrooms)       FILTER (WHERE s.bedrooms IS NOT NULL),
         array_agg(DISTINCT s.bathrooms)      FILTER (WHERE s.bathrooms IS NOT NULL),
         array_agg(DISTINCT btrim(s.storage_size)) FILTER (WHERE btrim(COALESCE(s.storage_size,'')) <> '')
    INTO v_layouts, v_beds, v_baths, v_sizes
    FROM unit_subtype_links l JOIN property_unit_subtypes s ON s.id = l.subtype_id
   WHERE l.unit_id = p_unit_id;

  -- 30 amp AND 50 amp is a real pedestal, so amp tags UNION rather than clash.
  SELECT array_agg(DISTINCT a) INTO v_amps FROM (
    SELECT unnest(CASE WHEN s.rv_amp_service = 'both' THEN ARRAY['30','50']
                       ELSE ARRAY[s.rv_amp_service] END) AS a
      FROM unit_subtype_links l JOIN property_unit_subtypes s ON s.id = l.subtype_id
     WHERE l.unit_id = p_unit_id
       AND s.rv_amp_service IS NOT NULL AND s.rv_amp_service <> 'none') q;

  -- A site is back-in or pull-through. Every other single-valued fact is the
  -- same: two tags making different claims is a contradiction only the landlord
  -- can settle, so it is refused by name rather than resolved by coin flip.
  IF array_length(v_layouts, 1) > 1 THEN
    RAISE EXCEPTION 'A site is back-in or pull-through, not both — pick one layout for this space.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF array_length(v_beds, 1) > 1 OR array_length(v_baths, 1) > 1 OR array_length(v_sizes, 1) > 1 THEN
    RAISE EXCEPTION 'Two of those subtypes describe the same thing differently — untick one.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_amp := CASE
    WHEN v_amps @> ARRAY['30','50'] THEN 'both'
    WHEN array_length(v_amps, 1) = 1 THEN v_amps[1]
    ELSE NULL END;

  UPDATE units SET
    rv_site_layout = COALESCE(v_layouts[1], rv_site_layout),
    rv_amp_service = COALESCE(v_amp,        rv_amp_service),
    bedrooms       = COALESCE(v_beds[1],    bedrooms),
    bathrooms      = COALESCE(v_baths[1],   bathrooms),
    storage_size   = COALESCE(v_sizes[1],   storage_size),
    updated_at     = NOW()
  WHERE id = p_unit_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION unit_subtype_links_sync() RETURNS trigger AS $$
BEGIN
  PERFORM sync_unit_facts_from_subtypes(COALESCE(NEW.unit_id, OLD.unit_id));
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Replaces the layout-only guard from 20260830233000: same rule, now part of the
-- one place that keeps a unit and its tags telling the same story.
DROP TRIGGER IF EXISTS trg_one_site_layout_per_unit ON unit_subtype_links;
DROP FUNCTION IF EXISTS one_site_layout_per_unit();
DROP TRIGGER IF EXISTS trg_unit_subtype_links_sync ON unit_subtype_links;
CREATE TRIGGER trg_unit_subtype_links_sync
  AFTER INSERT OR DELETE ON unit_subtype_links
  FOR EACH ROW EXECUTE FUNCTION unit_subtype_links_sync();

-- Bring every already-tagged unit into line with what its tags say.
SELECT sync_unit_facts_from_subtypes(id) FROM (SELECT DISTINCT unit_id AS id FROM unit_subtype_links) u;
