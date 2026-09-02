# SESSION 633 HANDOFF — Landlord identity refactor: the account is not an entity

## THE ONE JOB

Nic (DIRECTIVE, verbatim):

> "My account should be an account level setting. Each property could be linked
> individually to an entity or multiple properties to the same entity outside of
> the account controlling it. I don't want my account entity to be Oak Park. I
> want my account to just be my account. People buy and sell entities all the
> time. That's just a stupid structure. Things need to be set at the entity
> level, but the account needs to not be any entity at all. It needs to be
> sitting outside of it."

And, on scope: **"I don't wanna do it in three fucking stages. Do the shit. Do it
the right way."** He explicitly rejected a staged rollout. One pass, done properly.

He is blocked on real work until this lands — he is onboarding ~75 Mountain View
tenants today and cannot invite them while signed into a different entity.

## WHAT IS ACTUALLY WRONG

A landlord's SESSION *is* one `landlords` row. `users.active_landlord_id` picks
it; login stamps it into the JWT as `profileId`; ~269 landlord-context call sites
then treat `profileId` as "the landlord". A person who owns two LLCs is therefore
only ever half signed in.

This is not theoretical. It caused three separate bugs in session 632 alone,
each of which looked like a different bug:

1. **`GET /utility/meters` returned 404 for his own property.** Scoped
   `landlord_id = profileId`. Signed into Oak Park, every Mountain View meter
   call failed, the meter list came back empty, and every warning computed from
   it (opening reads, unread meters, the reading-run banner) evaluated to zero on
   a truthfully empty array. He spent three rounds looking for a banner that
   could not render. FIXED in 632 (uses `canAccessLandlordResource` now) — that
   fix is the template for this whole refactor.
2. **`PATCH /landlords/me/first-billing-cycle` could not reach his second
   entity.** He could see the card and had no way to set Mountain View.
3. **`POST /landlords/me/onboard-tenant-pending` refuses a unit at his other
   entity** — "unitId does not belong to this landlord". This is what blocks the
   Mountain View invites. It fails CLOSED (no cross-entity corruption), but it
   fails.

## THE TARGET MODEL

- **Account = the user.** Not an entity. Never an entity.
- **Entity = a `landlords` row.** Owned via `landlord_members`. Bought and sold.
- **Property links to an entity** (`properties.landlord_id` — already true).
- **Settings live at the grain they belong to** — entity or property, never
  "the account's entity."

### JWT
- `landlordIds` (every entity the user owns) becomes the ONLY landlord identity.
- `profileId` STOPS meaning "which landlord row" for role=landlord. Do not leave
  it holding an arbitrary entity id; that is the bug.
- `users.active_landlord_id` is retired as identity. At most a UI default for
  which entity a NEW property/invite is created under — and if kept, it must
  never gate a read.

### The two rules that replace it
- **READS span every owned entity.** `WHERE landlord_id = ANY(landlordIds)`.
- **WRITES take an explicit target** (`landlordId` / `propertyId` in the body),
  authorised with `canAccessLandlordResource` / `canManageLandlordResource`.

`middleware/scope.ts` already implements both helpers correctly. This refactor is
mostly *using them* where `profileId` is used today.

## SCOPE, MEASURED

```
747  profileId references, 149 files (all roles)
269  of them in landlord context   <-- the actual work
 16  direct `landlord_id = $n, [profileId]` query filters
```

Biggest landlord-context files: `routes/landlords.ts` (71), `routes/tenants.ts`
(57), `routes/esign.ts` (42), `routes/properties.ts` (12), `routes/leases.ts` (11).

**`routes/pos.ts` has 110 profileId refs and is NOT in scope** — POS is a
standalone product with its own isolation rules (memory: gam-pos-is-standalone,
gam-pos-business-isolation). Do not touch it. Same for tenant/business/pm_company
profileId uses: `profileId` remains correct for those roles. This refactor is
LANDLORD-ONLY.

## HOW TO DO IT

1. **Recon first.** `grep -rn "profileId" routes services jobs lib middleware |
   grep -v '\.test\.' | grep -i landlord`. Classify every hit: read / write /
   creation-default / not-landlord.
2. **Reads** → `= ANY($n::uuid[])` over `landlordIds`, falling back to
   `[profileId]` only if `landlordIds` is empty (older tokens in flight).
3. **Writes** → accept an explicit `landlordId`/`propertyId`, authorise with the
   scope helpers, and 403 with a sentence rather than 404-ing a person off their
   own data.
4. **Creation paths** (new property, new invite) need a *chosen* entity. Where
   the user owns exactly one, default to it silently. Where they own several,
   the request must name one — and the UI must offer a picker.
5. **Login** (`routes/auth.ts` ~line 300-410, and the second block ~534): stop
   resolving a single landlord row into `profileId` for role=landlord.
6. **Frontend**: a landlord who owns >1 entity needs an entity control on the
   creation paths (Add Property, Invite Tenant). There is NO switcher in the UI
   today — that absence is why this bit him.

## VERIFY WITH THIS EXACT CASE

Nic owns two entities. Reproduce and prove all three:
```sql
SELECT u.email, u.active_landlord_id,
       (SELECT string_agg(l.business_name,' | ') FROM landlords l WHERE l.user_id=u.id)
  FROM users u WHERE u.email='realestaterhoades@gmail.com';
```
- Signed into EITHER entity, `GET /utility/meters?propertyId=<the other one>` returns meters.
- Signed into EITHER entity, he can invite a tenant to a unit at the other.
- Another landlord's property still 404s. **The S396 cross-tenant protection must
  survive** — that is the one thing this refactor must not loosen.

Tests: `apps/api/src/routes/utility.test.ts` already has an S632 case
("a landlord reaches meters at every entity they own") that pins both halves.
Copy that shape for the invite path and the settings paths.

## STATE LEFT BEHIND (read before starting)

- **`active_landlord_id` was switched to Mountain View** at the end of 632 so Nic
  could invite today. That is a WORKAROUND, not a fix. He must re-login for it.
  He will need it flipped back to Oak Park at some point — or better, made
  irrelevant by this refactor.
- **HALF-APPLIED: `first_billing_cycle` moved from entity to property.** Migration
  `20260901140000_property_first_billing_cycle.sql` is applied; both Oak Park and
  Mountain View properties are set to 2026-09-01. BUT `jobs/moveInBundle.ts`
  still reads `landlords.first_billing_cycle`, and the Settings card in
  `apps/landlord/src/pages/SettingsPage.tsx` is mid-edit (per-entity rows, needs
  to become per-PROPERTY rows with a month picker). Behaviour is currently
  unchanged because both values match. FINISH THIS FIRST — it is small, and it is
  the same "wrong grain" mistake this refactor exists to correct.
  Nic: "if I onboard different properties that I own next month, it's gonna bill
  them right away. This needs to be a setting per property."
- **Unshipped, asked for:** the roster artifact
  (https://claude.ai/code/artifact/1b79f47b-aad4-46d3-a593-6bd1af077772) needs
  its 75 rows sorted alphabetically. Sort at RENDER time only — his corrections
  are in localStorage keyed to the stored order, and re-sorting the data would
  move his edits onto the wrong people.
- **Flagged, not built:** the tenant-onboarding "pending pool" tells him to
  upload PDFs to complete onboarding. That is the legacy paper-import path; he
  sends leases from templates. It should not present itself as the next step.

## DO NOT

- Do not touch POS, business, or pm_company scoping.
- Do not weaken cross-tenant isolation to make this easier.
- Do not stage it. He said so plainly.
- Do not run write tests against the live `gam` database. In 632 a probe
  overwrote three of his opening reads while he was entering them. Use `gam_test`.
