-- 10/20 (Nic, his own catch) — A STAY MOVED BY HAND STOPS CLAIMING IT WAS
-- PROMISED THE SITE IT IS NOW ON.
--
--   "They may have already gotten a confirmation on a space number. Our system
--    with compression and expansion is going to kind of screw that up if they
--    think they're locked to a specific site already."
--
-- `locked_to_unit` + `lock_reason` carry that: the stay cannot be moved off its
-- site, and the board says WHY. Every automatic path honors it — compression,
-- the extension relocations, out-of-order repacking, an unpaid hold moved aside
-- for a payer all refuse to touch a locked stay.
--
-- A PERSON IS NOT AN AUTOMATIC PATH. The landlord has real reasons the software
-- cannot know: the guest agreed to a different space on the phone, the site
-- flooded, the rig turned out to be too long. So a deliberate drag on the
-- Schedule is allowed — asked first, never silent (routes/units, the booking
-- PATCH).
--
-- What it must never do is leave the old sentence standing. Dale Carter was
-- promised RV 14 before GAM; move him to RV 09 and the detail panel went on
-- reading "Locked to RV 09 — Promised this space before GAM", which is a
-- sentence about a promise nobody made. The next person to read it believes RV
-- 09 is the space in Dale's confirmation email, and the one fact that mattered —
-- that the number in his hand is now WRONG — is gone off the screen.
--
-- So a hand move rewrites the reason rather than keeping it or clearing it.
-- Clearing it to NULL would read "Locked to this space by hand", which is true
-- and useless: it erases the promise, and GAM never erases. This third value
-- keeps both facts — the stay is still pinned here, AND somebody was promised
-- somewhere else and may not know yet.
--
-- The stay stays LOCKED either way. The desk just chose this site for them, so
-- compression has even less business shuffling them off it than before.
ALTER TABLE unit_bookings DROP CONSTRAINT IF EXISTS unit_bookings_lock_reason_check;
ALTER TABLE unit_bookings
  ADD CONSTRAINT unit_bookings_lock_reason_check
  CHECK (lock_reason IS NULL
         OR lock_reason IN ('promised_before_gam', 'promised_at_the_counter', 'moved_off_promised_site'));

COMMENT ON COLUMN unit_bookings.lock_reason IS
  'Why this stay cannot be moved off its site. promised_before_gam = the old system gave them this space number; '
  'promised_at_the_counter = the desk did; moved_off_promised_site = a person moved them off the space they were '
  'promised, so nothing here may call this one promised.';
