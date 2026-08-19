# Seasonal & Weekend Pricing — Design Spec (S602)

Status: DESIGN LOCKED (Nic, S602). Not built. Distinct from Snowbird (that's seasonal *tenancy*; this is *pricing*).

## Model
Rate overrides that layer on top of a subtype's base nightly/weekly/monthly rate.

- **Attaches per SUBTYPE** (`property_unit_subtypes` — where nightly/weekly/monthly + back-in/pull-through/amp already live). RVs price back-in vs pull-through separately; hotels price room types separately.
- **Seasonal windows:** up to **2 per subtype** (Nic-locked max). Each is a recurring **month/day** range (e.g. Oct 1–Apr 30) with its own nightly/weekly/monthly override. More than 2 busy periods → landlord should just raise the base rate. Recurs annually.
- **Weekend rate:** per subtype, Fri–Sun override (same Fri/Sat/Sun definition as amenities: dow 0/5/6). For motel + furnished Airbnb-style stays; RV parks can leave it unset. It's "seasonal pricing on a weekly cadence."
- **Precedence for a given night:** seasonal-window rate (if the night falls in a window) > weekend rate (if set + weekend) > base rate. A stay spanning nights/seasons **prices each night by its applicable rate** (prorate); weekly/monthly rates use the override for stays anchored in a window.

## Decisions locked (Nic, S602)
- Per subtype (not just per unit-type). ✔
- Max **2** seasonal windows. ✔
- Weekend rates included (motel/furnished). ✔
- Weekly cadence (weekend) + yearly cadence (season) share one override engine. ✔

## Build touches (when prioritized)
- `subtype_rate_overrides` table (or columns on `property_unit_subtypes`): kind ('season'|'weekend'), month/day range (season), nightly/weekly/monthly override, ≤2 season rows enforced.
- Booking price calc (`publicBooking.ts` + `get_property_pricing` agent tool) picks the per-night rate by precedence.
- Landlord config UI on the subtype rate editor.
- Visitor agent (`get_property_pricing`) surfaces seasonal/weekend rates.
