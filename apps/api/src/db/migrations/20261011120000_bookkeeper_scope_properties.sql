-- 10/11 (Nic) — A BOOKKEEPER KEEPS ONE PARK'S BOOKS, NOT THE WHOLE ACCOUNT'S
--
--   "I need to invite somebody to be a bookkeeper for the Mountain View
--    property. They don't need to see anything with Oak Park. ... They just
--    need to see the financials, money coming in, money going out,
--    maintenance... the maintenance costs."
--
-- A bookkeeper was tied to one company (bookkeeper_scopes.landlord_id) and saw
-- all of it. This narrows the scope to some of that company's properties.
--
--   property_ids  NULL      = every property the company owns (today's rows,
--                             and an owner who ticks nothing)
--                 non-empty = only these properties; every financial page and
--                             every allowed route reads only their money
--
-- The array is never empty: an empty choice is stored as NULL by the invite
-- and edit routes (routes/scopes.ts), and the CHECK holds them to it, so "no
-- properties" can never be mistaken for "all properties" by a reader.
--
-- access_level (read_only | read_write) is untouched: it still governs the
-- GAM Books ledger tools for whoever uses them today. The financial pages give
-- every bookkeeper the same fixed access — look, and add expenses.
--
-- Backfill: none — existing rows read NULL (the whole company, as today).
-- Safe drop: the column and its CHECK; nothing else depends on them.
ALTER TABLE bookkeeper_scopes
  ADD COLUMN property_ids uuid[] NULL;

ALTER TABLE bookkeeper_scopes
  ADD CONSTRAINT bookkeeper_scopes_property_ids_not_empty
  CHECK (property_ids IS NULL OR cardinality(property_ids) > 0);
