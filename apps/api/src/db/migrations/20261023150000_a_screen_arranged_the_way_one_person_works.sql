-- 10/21 (Nic) — EVERYBODY ARRANGES THEIR OWN SCREEN.
--
--   "Did you ever build my idea for people being able to drag the left
--    navigation bar into an order of their choosing... I feel like there's a
--    lot of stuff that I brought up that got skipped, and unless I remember it
--    again, it just doesn't get built."
--
--   "let's build the screens, the draggable nav, rearranging the dashboard
--    widgets."
--
-- Two asks, one shape: a PERSON saying where things go on their own screen.
-- An owner who lives on the Schedule wants it at the top; a bookkeeper never
-- opens it at all. Nothing about this belongs to a property, a company or a
-- role — it is one human's arrangement of their own workspace, so it hangs off
-- the user and nothing else.
--
-- It is deliberately NOT a settings table. No flags, no policy, no money, and
-- nothing here can change what anybody is ALLOWED to see: the nav still comes
-- out of visibleNavItemsFor and the API still refuses every page a person has
-- no permission for. An order that names a page they cannot open is simply
-- skipped when the screen is drawn. Worst case somebody drags things into a
-- mess and presses Reset.
--
-- One row per person per surface, because the two surfaces move independently
-- and a third (the POS tabs, say) should cost nothing but a new name.
--
-- Nothing is ever deleted from here. "Reset to default" writes an EMPTY layout
-- rather than removing the row — the same way everything else in GAM is kept
-- rather than erased, and it keeps `updated_at` meaning what it says.
CREATE TABLE IF NOT EXISTS user_ui_layout (
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'landlord_nav', 'landlord_dashboard' — the screen being arranged.
  surface    text        NOT NULL,
  -- The order, as a list of the keys that surface knows. Keys it does not know
  -- any more (a page that was renamed or retired) are ignored at draw time, so
  -- an old layout never hides a new page or breaks on a dead one.
  layout     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, surface),
  CONSTRAINT user_ui_layout_surface_known CHECK (surface IN ('landlord_nav', 'landlord_dashboard')),
  CONSTRAINT user_ui_layout_is_a_list CHECK (jsonb_typeof(layout) = 'array')
);

COMMENT ON TABLE user_ui_layout IS
  'One person''s arrangement of one of their own screens (10/21, Nic: the draggable nav and the dashboard widgets). Never permissions — what somebody may SEE is still decided by visibleNavItemsFor and the API.';
