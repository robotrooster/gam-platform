-- S650 (Nic): "I would just have it where you can make individual taxes and you
-- assign them to individual items or entire categories if you want to ... we're
-- not charging sales tax on the electricity. We are on the propane. They're
-- both utilities, so I don't want it to be on that category, but say there was
-- an area where there was tax on the electricity as well. I'd like to just be
-- able to choose to add it to the whole category simultaneously. The whole idea
-- is flexibility of operation."
--
-- ONE list of named taxes (pos_tax_rates), each applied to whole categories
-- and/or single items. Until now the item's "Tax Category" (pos_tax_categories)
-- was shown on the register but never read when the sale was charged; the
-- server read pos_tax_rates by category NAME, or the raw percentage on the
-- item. pos_tax_categories held only 0% placeholders and no item pointed at
-- one, so nothing live changes here.
--
-- Expand only: applies_to (category names / 'all') keeps working; the item
-- picker's column is left in place and simply no longer offered.
ALTER TABLE pos_tax_rates
  ADD COLUMN category_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN item_ids     uuid[] NOT NULL DEFAULT '{}';

-- Kinds of tax are not a thing the landlord sorts by. Arizona's transaction
-- privilege tax is one tax that the state splits with the county; a lodging
-- tax is simply named "Lodging tax". The column stays (NOT NULL) with a default.
ALTER TABLE pos_tax_rates ALTER COLUMN tax_type SET DEFAULT 'sales';

-- Each sale keeps the taxes it charged, by name, so a receipt can say
-- "Lodging tax $3.11" instead of a single "Tax" line.
ALTER TABLE pos_transactions ADD COLUMN tax_breakdown jsonb;
