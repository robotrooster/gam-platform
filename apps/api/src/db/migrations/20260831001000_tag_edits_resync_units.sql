-- S630 (Nic, DIRECTIVE — platform-wide): "The settings that you just made for
-- Mountain View, I want it to be platform wide. When you tag something, it
-- changes how it's viewed in the system."
--
-- Two gaps left after 20260830235000, both the same shape: a unit and its tags
-- telling different stories.
--
-- 1. EDITING A TAG changed nothing. The sync fired on link insert/delete only,
--    so correcting "Back In" from 30 amp to 50 left all nineteen spaces reading
--    30 until somebody happened to re-tag them. A class that can't be corrected
--    in one place is not a class.
-- 2. DWELLING OWNERSHIP was left out of the synced facts even though a subtype
--    carries it and it is exactly the same kind of statement — "Tenant Owned"
--    says who owns the home standing on the space. Whether the resident owns the
--    dwelling drives what an inspection covers, so it is not cosmetic.
--
-- Money is still never synced: rent, deposit and stay rates belong to the unit
-- (S629), and nothing here reads them.
CREATE OR REPLACE FUNCTION sync_unit_facts_from_subtypes(p_unit_id uuid) RETURNS void AS $$
DECLARE
  v_layouts text[]; v_amps text[]; v_beds int[]; v_baths numeric[];
  v_sizes text[]; v_owns text[]; v_amp text;
BEGIN
  SELECT array_agg(DISTINCT s.rv_site_layout) FILTER (WHERE s.rv_site_layout IS NOT NULL AND s.rv_site_layout <> 'none'),
         array_agg(DISTINCT s.bedrooms)       FILTER (WHERE s.bedrooms IS NOT NULL),
         array_agg(DISTINCT s.bathrooms)      FILTER (WHERE s.bathrooms IS NOT NULL),
         array_agg(DISTINCT btrim(s.storage_size)) FILTER (WHERE btrim(COALESCE(s.storage_size,'')) <> ''),
         array_agg(DISTINCT s.dwelling_ownership)  FILTER (WHERE s.dwelling_ownership IS NOT NULL)
    INTO v_layouts, v_beds, v_baths, v_sizes, v_owns
    FROM unit_subtype_links l JOIN property_unit_subtypes s ON s.id = l.subtype_id
   WHERE l.unit_id = p_unit_id;

  -- 30 amp AND 50 amp is a real pedestal, so amp tags UNION rather than clash.
  SELECT array_agg(DISTINCT a) INTO v_amps FROM (
    SELECT unnest(CASE WHEN s.rv_amp_service = 'both' THEN ARRAY['30','50']
                       ELSE ARRAY[s.rv_amp_service] END) AS a
      FROM unit_subtype_links l JOIN property_unit_subtypes s ON s.id = l.subtype_id
     WHERE l.unit_id = p_unit_id
       AND s.rv_amp_service IS NOT NULL AND s.rv_amp_service <> 'none') q;

  IF array_length(v_layouts, 1) > 1 THEN
    RAISE EXCEPTION 'A site is back-in or pull-through, not both — pick one layout for this space.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF array_length(v_beds, 1) > 1 OR array_length(v_baths, 1) > 1
     OR array_length(v_sizes, 1) > 1 OR array_length(v_owns, 1) > 1 THEN
    RAISE EXCEPTION 'Two of those subtypes describe the same thing differently — untick one.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_amp := CASE
    WHEN v_amps @> ARRAY['30','50'] THEN 'both'
    WHEN array_length(v_amps, 1) = 1 THEN v_amps[1]
    ELSE NULL END;

  UPDATE units SET
    rv_site_layout     = COALESCE(v_layouts[1], rv_site_layout),
    rv_amp_service     = COALESCE(v_amp,        rv_amp_service),
    bedrooms           = COALESCE(v_beds[1],    bedrooms),
    bathrooms          = COALESCE(v_baths[1],   bathrooms),
    storage_size       = COALESCE(v_sizes[1],   storage_size),
    dwelling_ownership = COALESCE(v_owns[1],    dwelling_ownership),
    updated_at         = NOW()
  WHERE id = p_unit_id;
END;
$$ LANGUAGE plpgsql;

-- Correcting a class corrects every space in it, which is the whole point of
-- having a class. Only fires when a synced fact actually moved — a rename or a
-- price edit re-syncs nothing.
CREATE OR REPLACE FUNCTION property_unit_subtypes_resync() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  IF NEW.rv_site_layout IS DISTINCT FROM OLD.rv_site_layout
     OR NEW.rv_amp_service IS DISTINCT FROM OLD.rv_amp_service
     OR NEW.bedrooms IS DISTINCT FROM OLD.bedrooms
     OR NEW.bathrooms IS DISTINCT FROM OLD.bathrooms
     OR NEW.storage_size IS DISTINCT FROM OLD.storage_size
     OR NEW.dwelling_ownership IS DISTINCT FROM OLD.dwelling_ownership THEN
    FOR r IN SELECT unit_id FROM unit_subtype_links WHERE subtype_id = NEW.id LOOP
      PERFORM sync_unit_facts_from_subtypes(r.unit_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_property_unit_subtypes_resync ON property_unit_subtypes;
CREATE TRIGGER trg_property_unit_subtypes_resync
  AFTER UPDATE ON property_unit_subtypes
  FOR EACH ROW EXECUTE FUNCTION property_unit_subtypes_resync();

SELECT sync_unit_facts_from_subtypes(id) FROM (SELECT DISTINCT unit_id AS id FROM unit_subtype_links) u;
