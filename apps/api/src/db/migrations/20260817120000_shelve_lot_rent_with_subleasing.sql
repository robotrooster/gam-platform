-- S605 (Nic): fold LOT RENT & NET into the sublease shelf — both off.
--
-- Nic's read, and it's correct: lot rent isn't a separate product, it's the
-- accounting half of the same business case. "If it was gonna be had, it would
-- be blended into the sublease deal where I own a bunch of houses in different
-- parks, I pay lot rent, and I sublease to those tenants. It wouldn't be any
-- different from subleasing."
--
-- And the version we built can't work for the same reason the sublease flow
-- can't: the outside park is NOT on GAM, so there is no lease data, no rent
-- roll, no charges to reconcile against — the operator would hand-enter every
-- figure. Nic: "everything would have to be manually input in that instance.
-- It's not worth having."
--
-- So one shelf governs both halves. `subleasing_enabled` (S605, already FALSE)
-- now gates lot-rent accrual and its UI too, rather than adding a second flag
-- for what is really one shelved workflow.
--
-- SHELVED, NOT DELETED — same posture as OTP and the sublease subsystem.
-- lot_rent_charges, services/lotRent.ts, routes/lotRent.ts, the daily accrual
-- cron and their tests all stay; they simply stop creating anything new.
--
-- No backfill and nothing stranded: zero lot_rent_charges rows exist, and zero
-- properties are marked operator_owns_land = FALSE.

UPDATE system_features
   SET description = 'Sublease subsystem AND its lot-rent/net accounting half (investor-operator owning homes in an external park). SHELVED S605 — both require the other party on-platform or full manual entry to be useful. OFF = sublease creation refused and lot-rent accrual skipped; existing records stay readable. Backends intentionally dormant, not deleted.'
 WHERE key = 'subleasing_enabled';
