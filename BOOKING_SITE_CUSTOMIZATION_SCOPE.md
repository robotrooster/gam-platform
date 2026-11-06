# Booking-site customization — what it is, and what I did NOT build

10/27. Nic listed "booking-site customization (Wix-style)" among the items
before the deploy. **I did not build it, and I want to be straight about why
rather than ship a quarter of it.**

## What exists today

A property's booking site is a slug and five editable things: an intro, an
about section, an area description, photos, and the money settings (deposit
percentage, who pays the card fee, whether utilities are billed). Everything
else — layout, colors, type, logo, section order, any page beyond the one —
is fixed by the app.

So a landlord can change the WORDS and the PICTURES, and nothing about how it
looks.

## What "Wix-style" actually means

A page builder: drag sections onto a canvas, reorder them, pick a theme, add
pages, set fonts and colors, preview, publish. That is a product in its own
right. Wix has spent eighteen years on it. The honest estimate is weeks, not
an evening, and most of the cost is not the editor — it is that every section
becomes a thing that has to keep rendering correctly on every screen forever,
including the ones nobody arranged sensibly.

Building a tenth of it tonight would produce the worst version: enough of an
editor to raise the expectation, not enough to meet it.

## The three ways to go, cheapest first

**1. Branding, not building (days).** Logo, one accent color, a hero photo
choice, and the ability to turn sections on and off and reorder them. No
canvas, no new sections, no new pages. This is what most landlords mean when
they say "make it look like mine," and the whole booking site keeps working
because the sections are still ours.

**2. Themes (a week-plus).** The above, plus three or four ready-made looks a
landlord picks between. More design work than engineering work.

**3. A real builder (weeks).** Sections on a canvas, new pages, fonts, the
lot. Only worth it if booking sites are going to be a selling point on their
own rather than a place a guest lands and books.

## My recommendation

**Option 1, and after the expensive look-and-feel pass, not before.** Two
reasons:

- A landlord-facing color picker built the week before the design pass is
  work done twice — the pass will change what the sections look like, and the
  controls have to match whatever it lands on.
- Nothing is blocked by it. Booking sites work today; they just all look like
  GAM.

## What I need from Nic

Only this: **is "make it look like mine" what you meant, or did you mean a
real builder?** If it is the first, it is a few days after the design pass. If
it is the second, it is its own project and worth planning properly.
