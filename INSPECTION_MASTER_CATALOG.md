# Inspection Master Catalog (S573 redesign — Nic)

ONE master list of every inspectable category across all unit types nationwide.
The unit's setup filters it down to only what the unit actually HAS. Nothing is
ever "N/A" — if it's not on the unit, it's not on the checklist. This catalog is
also the training set for the walkthrough agents.

**Condition (shared):** Excellent · Good · Fair · Damaged/Missing
**Capture per item:** condition (always) + optional photo; a note only exists
attached to a photo. No repair-cost field.

**Gate legend:**
- `‹all interior›` — every landlord-inspected interior unit (apartment / single-family / park-owned mobile home / hotel room)
- `‹count:N›` — repeats up to the unit's real count (bedrooms, bathrooms, living areas)
- `‹feature:x›` — appears only if the landlord marks that feature at unit setup
- `‹type:x›` — only that unit type
- `‹multi-level›` `‹grounds›` — placement/ownership driven

---

## 1. Bedrooms  `‹count: bedrooms›`  (one set per real bedroom)
1. Walls & paint
2. Flooring
3. Ceiling
4. Closet & shelving
5. Window — operation, screen & lock
6. Window covering / blinds  `‹feature: provides_blinds›`
7. Outlets & light switches
8. Ceiling light fixture
9. Ceiling fan  `‹feature: ceiling_fans›`
10. Entry door
11. Smoke detector

## 2. Bathrooms  `‹count: bathrooms›`  (full vs half by unit)
12. Toilet
13. Sink & vanity
14. Faucet & fixtures
15. Tub / shower  `‹full baths›`
16. Shower surround / tile & grout  `‹full baths›`
17. Mirror / medicine cabinet
18. Exhaust fan / ventilation
19. Flooring
20. Walls & ceiling
21. GFCI outlet
22. Towel bars / accessories
23. Visible leaks / water shutoffs

## 3. Kitchen  `‹all interior›`
24. Cabinets & drawers
25. Countertops
26. Sink & faucet
27. Backsplash
28. Range / oven  `‹feature: provides_range›`
29. Range hood / vent
30. Refrigerator  `‹feature: provides_refrigerator›`
31. Dishwasher  `‹feature: provides_dishwasher›`
32. Microwave  `‹feature: provides_microwave›`
33. Garbage disposal  `‹feature: garbage_disposal›`
34. Pantry  `‹feature: pantry›`
35. Flooring
36. Walls & ceiling
37. Outlets (incl. GFCI)
38. Lighting

## 4. Living / Dining / Family room  `‹count: living_areas›`
39. Walls & paint
40. Flooring
41. Ceiling
42. Windows — operation & screens
43. Window coverings / blinds  `‹feature: provides_blinds›`
44. Ceiling fan  `‹feature: ceiling_fans›`
45. Light fixtures
46. Outlets & switches
47. Fireplace  `‹feature: fireplace›`
48. Dining area

## 5. Hallways / Stairs  `‹all interior›`
49. Hallway walls & flooring
50. Coat / linen closet  `‹feature: hall_closet›`
51. Hallway smoke / CO detector
52. Staircase & treads  `‹multi-level›`
53. Handrail — secure & sturdy  `‹multi-level›`
54. Landing  `‹multi-level›`
55. Stairwell lighting  `‹multi-level›`

## 6. Laundry  `‹feature: in_unit_laundry›`
56. Washer  `‹feature: provides_washer›`
57. Dryer  `‹feature: provides_dryer›`
58. Washer / dryer hookups
59. Dryer vent
60. Utility sink  `‹feature: utility_sink›`
61. Flooring & walls

## 7. Systems & Safety  `‹all interior›`
62. Heating — furnace / HVAC
63. Thermostat
64. Cooling — A/C  `‹feature: central_ac›`
65. Cooling — evaporative cooler  `‹feature: evap_cooler›`
66. Water heater
67. Electrical panel / breakers
68. Smoke detectors (unit-wide)
69. Carbon-monoxide detectors
70. Fire extinguisher  `‹feature: fire_extinguisher›`
71. Plumbing — visible leaks / shutoffs
72. Vents / registers / ductwork

## 8. Entry & Doors  `‹all interior›`
73. Front door & deadbolt
74. Back / rear door  `‹feature: back_door›`
75. Screen / storm door  `‹feature: screen_door›`
76. Sliding glass / patio door  `‹feature: patio_door›`
77. Garage interior door  `‹feature: attached_garage›`
78. Doorbell / intercom  `‹feature: doorbell›`

## 9. Exterior / Structure  `‹type: single_family, mobile_home›`
79. Exterior walls / siding
80. Roof & gutters (visible)
81. Skirting  `‹type: mobile_home›`
82. Foundation / piers  `‹type: mobile_home›`
83. Exterior lighting
84. Exterior faucets / hose bibs
85. Porch / stoop / entry steps
86. Patio / deck  `‹feature: patio_deck›`
87. Balcony  `‹feature: balcony›`
88. Garage / carport  `‹feature: garage_carport›`
89. Driveway / parking pad

## 10. Yard & Grounds  `‹grounds — single_family, mobile_home lot, incl. tenant-owned›`
90. Front yard — landscaping & condition
91. Back yard — landscaping & condition
92. Weeds / vegetation overgrowth
93. Trees / shrubs
94. Fencing & gates  `‹feature: fenced›`
95. Sprinkler / irrigation  `‹feature: sprinklers›`
96. Shed / outbuilding  `‹feature: shed›`
97. Trash / debris removed

## 11. RV Site  `‹type: rv_spot›`
98. Pad surface / condition
99. Site leveling
100. Electric pedestal / hookup
101. Water connection / spigot
102. Sewer connection
103. Weeds / vegetation
104. Trash / debris removed
105. Site marker / number
106. Picnic table  `‹feature: park_picnic_table›`
107. Fire ring / grill  `‹feature: park_fire_ring›`

## 12. RV Rig  `‹type: rv_spot + park-owned›`
108. Rig interior — sleeping / seating / cabinets / flooring
109. Kitchenette — stove / fridge / sink / microwave
110. RV bath — toilet / shower / sink / ventilation
111. RV systems — A/C & furnace / water heater / detectors / slide-outs
112. RV exterior — body & roof / windows & seals / awning / steps & handrails

## 13. Storage / Parking  `‹type: storage, parking›`
113. Unit empty / cleared
114. Door operation
115. Latch / locking mechanism
116. Interior walls & floor  `‹type: storage›`
117. Roll-up door  `‹feature: rollup_door›`
118. Space markings / number  `‹type: parking›`

## 14. Handover / Meta  `‹all›`
119. Keys / remotes / fobs
120. Mailbox key  `‹feature: mailbox›`
121. Garage-door opener  `‹feature: garage_carport›`
122. Gate / access codes  `‹feature: gate_code›`
123. Utility meter readings

---

## Unit-setup feature toggles (the applicability inputs)

Beyond bedrooms / bathrooms / living-area counts / unit type / ownership /
multi-level / floor placement, the landlord marks (per unit) which of these the
unit HAS. These drive the `‹feature:*›` gates above:

`provides_blinds` · `ceiling_fans` · `provides_range` · `provides_refrigerator`
· `provides_dishwasher` · `provides_microwave` · `garbage_disposal` · `pantry`
· `fireplace` · `hall_closet` · `in_unit_laundry` (+ `provides_washer`,
`provides_dryer`, `utility_sink`) · `central_ac` · `evap_cooler` ·
`fire_extinguisher` · `back_door` · `screen_door` · `patio_door` ·
`attached_garage` · `doorbell` · `patio_deck` · `balcony` · `garage_carport` ·
`fenced` · `sprinklers` · `shed` · `park_picnic_table` · `park_fire_ring` ·
`rollup_door` · `mailbox` · `gate_code`

---

## Locked decisions (Nic, S573)
- **Condition:** Excellent / Good / Fair / Damaged-or-Missing (one shared option). **No N/A ever** — applicability comes from unit setup; an un-inspected item is "not inspected" (null), never "N/A".
- **Photo mandatory** on every applicable item (same standard for staff-in-person and tenant-remote). **Note attaches to the photo; optional for Excellent/Good, required for Fair/Damaged/Missing** (context on what's wrong). **No repair-cost field** — actual cost links to the unit later via maintenance.
- **Living areas = a count** (default 1) at unit setup; the living-area items repeat that many times (like bedrooms).
- **Per-unit-type presets:** each unit type ships with sensible feature defaults ON; the landlord only toggles *extras* per unit. Configuration is **optional** — a unit with zero config still inspects correctly off its preset. Features live in `units.features` (jsonb — new feature keys need no migration; the product evolves via feature requests).
- Catalog above = v1 starting set, approved.

## Build plan (staged, each stage lands green)
1. ✅ **Feature model** — `units.features` jsonb + `units.living_areas` int (migration 20260731210000); shared `UNIT_FEATURE_CATALOG` + `resolveUnitFeatures()` + `featuresForType()`. 30 feature keys, preset-on-by-type.
2. ✅ **Catalog resolver** — `buildInspectionChecklist` rewritten off the full ~123-item catalog, gated by type/counts/living-areas/ownership/multi-level/ADA/features. Threaded livingAreas+features through every call site. 15 resolver + 81 inspection tests green. (Seed still uses 'na' as the un-inspected placeholder until stage 3.)
3. ✅ **Condition model** — enum → excellent/good/fair/damaged_missing (nullable = not-inspected); migration 20260731220000 converts existing (na→null, damaged|missing→damaged_missing); updated finalize condition_result, comparison rank (INSPECTION_CONDITION_RANK), report, agent-tool validation, shared const + INSPECTION_ITEM_CONDITION_LABEL. Seed now inserts NULL (un-inspected), never 'na'. 135 tests green.
4. ✅ **Conduct UX — DONE + DEPLOYED.**
   - condition dropdowns (excellent/good/fair/damaged_missing), repair column removed, null shows "Not inspected".
   - **Completeness enforcement** (`getInspectionCompleteness`/`completenessMessage`): finalize + move-in sign require condition-on-every-item + **photo per AREA** (via unit_inspection_photos.item_id→area) + note on every fair/damaged; **tenant periodic submit** requires photo-per-area + notes-on-flagged only (tenants document, staff assess). New `GET /:id/completeness`.
   - **Per-area photo-capture UI** (landlord InspectionDetailPage + tenant main.tsx): checklist grouped by area, each area has a 📷 capture button that links the photo via itemId + a PHOTO REQUIRED/✓ badge; a live "To finish: N items need a condition · M areas need a photo · K need a note" banner; note-field flips to "required" on fair/damaged; submit/finalize blocked until satisfied. Verified live (set Fair → banner updated + note went required; finalize 409'd with the message).
   - 81 inspection + 15 resolver tests green, all 4 apps typecheck, rebuilt + kickstarted. **The whole catalog + condition + conduct redesign is LIVE.**
5. ✅ **Unit-features setup UI — DONE + DEPLOYED.** `/details` + create route accept `features` (jsonb, sanitized to keys the catalog offers for the type) + `livingAreas`; consolidated unit editor (UnitDetailPage) has a "FEATURES ON THIS UNIT" section — grouped toggles (Appliances/Rooms/Laundry/Systems/Doors/Exterior/Handover) defaulted from the type presets + a Living-areas dropdown. Verified live (apartment shows Range/Fridge/Blinds pre-checked). 40 units tests green. Lease-lock still applies (features editable only between leases).

LIVE STATE: **ALL STAGES 1-5 DONE + DEPLOYED.** The entire inspections overhaul + catalog redesign is complete and live.
