# Printing is always light — fixed 10/26

**The bug.** Nic printed a balance summary while doing two evictions at Oak
Park. The portal was in dark mode, so the page came out a solid black sheet
with white text. *"That wasted so much ink on a brand new cartridge."*

**The rule.** A printed page is always the light palette, whatever the screen
is set to.

**How.** Every portal already ships a full light palette under
`:root[data-theme="light"]`, including the per-component overrides (gold as
text becomes `--gold-ink`, alert copy flips to dark-on-tint, table hovers
change). So rather than restate that palette inside `@media print` — which
would drift the moment the light theme changes —
`installPrintLightTheme()` (`packages/shared/src/printTheme.ts`) flips the
document to the light theme for the duration of the print and puts the
viewer's own choice back afterwards. Every light rule then applies, with
nothing duplicated.

Installed at startup in every portal: landlord, tenant, admin, POS, books,
business, customer, listings, property-intel, admin-ops, storefront.

A CSS backstop sits in each portal's stylesheet forcing a white page and dark
body text, for a print that happens before the script runs. The failure being
guarded is a wasted ink cartridge, not a cosmetic one, so it is belt and
braces.

Tested: `packages/shared/src/printTheme.test.ts` — 8 cases, including that a
viewer on dark gets dark back, a viewer on the default gets no attribute back
(rather than being pinned to light), and two print events for one print do not
leave the viewer stuck on light.
