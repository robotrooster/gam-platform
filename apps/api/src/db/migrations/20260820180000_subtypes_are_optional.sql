-- S613 CORRECTION (Nic, same session): SUBTYPES ARE OPTIONAL.
--
-- "Units have no individual price. The price is derived from the subtype... A
--  unit with no subtype CAN have a setting. But when there is a subtype set,
--  all units with that subtype have to be the same price. If one doesn't
--  exist, then it can be a different price."
--
-- 20260820170000 read that as "every unit must belong to a class" and acted on
-- it: it minted 8 classes nobody asked for and pulled 37 units into them.
-- The RULE was right — a class sets one price for every unit in it — but making
-- membership compulsory was not, and inventing "Back-in 30 amp no deposit"
-- beside the classes the landlord named himself is exactly the clutter this
-- work exists to remove.
--
-- This puts the data back where it was. What SURVIVES from that migration is
-- the part Nic actually described: the trigger that pushes a class's price onto
-- every unit in it. A unit with no class keeps its own price, editable on the
-- unit, as before.
--
-- Prices are untouched here and were untouched there: the backfill grouped by
-- the numbers each unit already had, and no class was edited, so the trigger
-- never fired on live data.

UPDATE units SET subtype_id = NULL, updated_at = NOW()
 WHERE id IN ('0b268d15-c43a-47cd-a488-ae206c6aa234','1316c82e-10d6-4a33-b51e-ebf6c537316e','1facb75e-11e3-425e-a8c0-5b50a5fb899d','283e79e6-b82e-4ca6-9e52-0301b6c1301f','29a5eb67-f9b3-4336-ac72-9e70caa99f07','2b5fe900-6d9b-4330-b470-32ba99028675','2d43a094-acdc-47e9-ad31-0d418da68654','2da25f00-db61-46c3-a271-485c27cc9494','3e60cb5e-93ee-43c6-9632-4385de789eaa','42da8b01-da38-4a42-8ad0-3c8bba303ae9','43a9008f-52e2-4b29-8ca0-6bac8d24c8ee','45409813-f050-4208-9d30-73d6ae6b2371','4972f7ef-6e4f-4cb6-aab0-c95a0540c18d','4d9f4c5b-7a63-4039-a8a9-c518b3e93631','4fb84696-7346-47d5-b2f6-1b2c2266b063','50d31602-aa4a-4675-98b6-218b9769e24d','512dcbdd-4702-4303-9c8d-19adc55742ee','6337f1eb-21f2-4815-945d-876cb5d221ed','75c7d38b-a3f7-47db-b6a8-1ff2c92297c4','77c23648-f800-4f82-b6f7-e02892a7d6da','897b1d00-ee8e-417a-9d44-ef2d0976492c','8ff6a9c1-7d55-4543-82c7-b5840e87da7b','96be1ea8-64d8-4b35-adb3-31e74db44eba','aedb4ff2-e3eb-4500-8621-26bc86362c3f','b7de05a3-c5ba-41fe-838d-adb7045ded3a','ca8fe196-395d-4a85-9d4b-7482d9de2021','ca965a1e-5dda-42bc-a4e8-48a659b0daf6','cc791864-adff-4e56-b903-5bab35781686','d4848bbd-0c94-4db6-a118-86068d66316d','db505107-b3cb-4a4b-ab8c-1f2adfcd8c2e','e5678079-1a3f-44f0-976f-fda889e0f070','e8416988-91f8-4b68-bdfc-afe647a1da98','ea0615ae-60b7-4ec9-871e-c68d07821fa8','ea19bd0f-c33a-4b26-b056-dc377fafa1c4','f65c601b-4737-464b-afec-b226db9a84c9');

UPDATE units SET subtype_id = '64d02342-7fdf-458a-ac70-4cfa18ddc0d1', updated_at = NOW() WHERE id = '249fc2d4-f123-4174-81c9-82d60f18766d';
UPDATE units SET subtype_id = '64d02342-7fdf-458a-ac70-4cfa18ddc0d1', updated_at = NOW() WHERE id = 'b26aa7b5-2ede-483f-9d79-9d84fac6bea3';

-- The invented classes, removed only where nothing came to depend on them.
DELETE FROM property_unit_subtypes s
 WHERE s.id IN (
   '05e16942-e48d-4161-8bf9-17152abff7c8',
   '3a3969ca-5c12-4897-9ced-47e8a9961ee5',
   '614ff052-409f-4c09-adb7-a62106c932d2',
   '68beb1d4-cfa0-4c65-9363-48950129e985',
   '81120e4d-9811-4837-acaf-e81cb3c64448',
   'a8a650c1-8ccb-46e3-9138-11a224948c0b',
   'b0677575-22c4-4f4d-807e-f1a7824d6a2d',
   'bf986140-5a46-4ddc-8781-0e143de854a5'
 )
   AND NOT EXISTS (SELECT 1 FROM units u WHERE u.subtype_id = s.id);
