-- S536 (Nic): the POS register gets a quick-add for repeat customers —
-- a walk-in buying supplements weekly has a name and maybe a phone, not
-- necessarily an address on file. Address becomes optional; the
-- route-optimization / service-visit features already only operate on
-- customers with geocoded addresses, so address-less POS customers
-- simply never appear on routes. No backfill needed (relaxing NOT NULL).
ALTER TABLE business_customers ALTER COLUMN street1 DROP NOT NULL;
ALTER TABLE business_customers ALTER COLUMN city    DROP NOT NULL;
ALTER TABLE business_customers ALTER COLUMN state   DROP NOT NULL;
ALTER TABLE business_customers ALTER COLUMN zip     DROP NOT NULL;
