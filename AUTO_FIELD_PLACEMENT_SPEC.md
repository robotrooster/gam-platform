# Auto Field-Placement for Lease Templates — SPEC (S555)

Goal: when a landlord uploads a raw lease PDF at onboarding, the system
auto-detects and places the e-sign field boxes (positioned + tagged to the
right `lease_column` + signer role), turning the ~1hr/template manual job into
review-and-nudge. Launch-critical for Oak Park onboarding (Nic, S555).

Output = native `lease_template_fields` rows
({fieldType, signerRole, leaseColumn, page, x, y, width, height}), saved via
`PUT /esign/templates/:id/fields`. Landlord reviews/adjusts before use.

## Proven so far (S555 prototype, on the real Oak Park apartment lease)
- Deterministic blank detection + coordinate flip (pdfjs y-up baseline →
  editor top-left y-down: `y_box = pageHeight - y_text`) WORKS. Boxes land on
  the blanks. Best on structured areas (amount-due table: perfect placement +
  tagging rent_amount/security_deposit/pet_deposit/pet_fee; signature lines:
  perfect placement).
- Semantic tagging (what IS each box) is the model's job — the extraction spike
  showed the local Hermes model reads lease semantics well (fees + citations).
- Prototype scripts in scratchpad: extract2.cjs (text), extract_v2.cjs (fee
  extraction w/ candidate-sweep + planes + code-verified citations),
  _autoplace_tmp/_render_tmp (detection + overlay render).

## Confirmed existing flows (do NOT rebuild)
- **Signing dates auto-stamp.** date_signed/signature/initial fields are filled
  by the signer at signing (esign.ts:283, :2761) — place the box, it auto-fills
  with the signing date. No manual date entry.
- **4 spots / 2 signers auto-completes.** Completion = all ASSIGNED signers
  signed (esign.ts:2799 COUNT signers WHERE status!='signed' == 0). Fields for
  roles not on the document are never instantiated (esign.ts:281). Extra
  signature boxes are dropped, never block. Flow intact.

## PLACEMENT REQUIREMENTS (Nic, S555)

1. **NO TEXT OVERLAP (core rule).** A box may overlap ONLY the blank/underline
   space — never any printed text. When the field value renders it overlays on
   top and would cover text. Constrain every box's width/position to the
   underline extent, not the surrounding words.

2. **Occupancy / tenant-name fields → default 4 name-sized boxes.** For
   "names of persons occupying" / tenant lines, auto-split the line into 4
   boxes, each ~average-name width, non-overlapping and legible.

3. **Field-type accuracy.** signature → `signature`, date lines → `date`
   (auto-stamp), checkboxes ("___ FIXED TERM", "___ May continue") → checkbox.

4. **Signer-role distinction.** Landlord-signature boxes → signerRole=landlord;
   tenant-signature boxes → signerRole=tenant. (The "SIGNATURE" label sits
   ABOVE the line, not beside — heuristic misses it; model must read it.)

5. **Initials boxes on every page that has NO signature spot — TENANT signers
   ONLY, not the landlord.** (Corrected S555: it's the landlord's own lease;
   initials are the tenant's confirmation they've seen each page.) One initial
   box per tenant signer — up to 4 — near a bottom corner, stacked vertically
   OR horizontally along the bottom, non-overlapping and covering NO relevant
   text (rule #1). Ties to req #2/#4: the up-to-4 tenant-signer model.

6. **Fallback UX.** On landlord upload, PRE-PLACE boxes as a starting point and
   let the landlord adjust size/position. Fine-tuning reduces their work but the
   auto-placement doesn't have to be pixel-perfect.

## Engine status (S555) — apps/api/scripts/autoFieldPlacement.core.cjs
DETERMINISTIC engine built + verified on BOTH real Oak Park leases (apartment
8pp, mobile-home 9pp), rendered overlays, self-checked **0 box overlaps, 0 text
overlap**. FIXED: sub-item underscore runs (real width, never crosses text);
hard no-overlap pass (resolveOverlaps, trims/drops); 4 name boxes on
tenant/occupancy lines; per-page tenant initials (bottom-right, ≤4, only on
no-signature pages); signature roles by horizontal position (SIGN:T/SIGN:L);
date fields for both underline blanks AND "/ /" signing lines; checkboxes
shortened; Apartment #, generalizes to the different mobile-home structure.

REMAINING TAIL (needs the model-tagging pass, not yet built):
- Occupancy "Names of persons:" → 1 box not 4 (label sits on the line ABOVE the
  blank — needs label-above name detection).
- A 2nd stacked tenant signature line reads `text` (no header directly above).
- "beginning/ending on" tagged generic `date` not `start_date`/`end_date`.
- Model pass should also REJECT decorative underscores + refine column/type.

NOT YET WIRED (next): model-tagging pass; port core → services/
autoFieldPlacement.ts (uses lib/pdfText.ts extractPositionedText); route
POST /esign/templates/:id/auto-fields → returns proposed fields; "Auto-place
fields" button in ESignPage that loads them into the existing editor for the
landlord to confirm/adjust (existing PUT /templates/:id/fields saves).

## S555 round-2 feedback (Nic) — to implement next

Signer model (confirmed): tenant roles = `primary` + `co_tenant_1..N`;
`landlord`; optional `witness`. Unfilled template slots are PRUNED at send
(esign.ts:44,281) — so place up to 4 tenant slots freely.

**Per-signer vs single field — DECIDED (Nic S555):**
- PER-SIGNER, up to 4 boxes (roles primary, co_tenant_1/2/3): printed NAME,
  **contact/phone, BIRTHDATE, driver's license**, SIGNATURE, INITIALS, mailing
  address, emergency contact. Rationale: each tenant needs their own contact +
  ID, and BIRTHDATE is required (must be 18 to sign). So the mobile-home
  Telephone(s)/Birthdate(s)/Driver's License(s) single lines → split into up to
  4 per-tenant boxes (slight box overlap OK per the new overlap rule).
- OCCUPANT ROSTER line ("names of all persons occupying/staying") → ADAPTIVE:
  if the lease gives ONE line, one landlord-typed box (landlord/agent types the
  names); if the lease itemizes each occupant as its OWN line, one box per line.
  Handle BOTH — do not force one model.
- Property/term/money fields → single box.
- **COMPREHENSIVENESS MANDATE: capture EVERY field the lease asks for.** A
  landlord will not execute an incomplete lease, so no requested blank may be
  skipped. When unsure of a blank's meaning, still place a box (typeable) rather
  than omit it.

Concrete fixes:
- p7 2nd tenant signature line still reads `text` → must be `signature`.
- Create 4 TENANT signature boxes (primary + co_tenant_1..3): 2 lines exist,
  INVENT 2 more in the blank space below, linked to those roles.
- p7 LANDLORD side missing its date box → add landlord date_signed box.
- Occupancy §3 / mobile §2 "names of all persons" → ONE box (landlord-typed),
  NOT a 4-split (revises the earlier occupancy-4-split idea).
- Per-signer NAME line (TENANT(S):) → 4 boxes (already working).

**NEW STANDING RULE (Nic S555) — overlap priority.** Text-overlap is the HARD
no. But when the choice is (a) a box slightly overlaps ANOTHER BOX vs (b) a box
shrinks so small it covers a WORD — PREFER slight box-box overlap. Field input
renders centered in the box, so a little corner overlap between boxes is fine;
covering document text is not. So resolveOverlaps must NOT shrink a box below a
usable min or drop it to avoid box overlap — allow slight box overlap instead;
only avoid TEXT overlap absolutely.

## Build shape (proposed)
1. Deterministic pass: detect blanks (underscore runs, "/ /" date lines,
   checkbox markers, signature/initial lines), compute positions with the flip,
   constrain width to the underline extent (rule #1).
2. Model pass: classify each detected target → {fieldType, leaseColumn,
   signerRole, label}, using surrounding text incl. labels ABOVE the line.
3. Rule pass: inject 4 name boxes on occupancy lines; inject per-page
   initials boxes (bottom-right) on no-signature pages.
4. Write native lease_template_fields; render an overlay preview for the
   landlord to confirm/adjust.

## Related (bank for onboarding, same engine)
- Pre-printed fixed fees baked in prose ($5/day late, $100 carpet, $35 notice)
  have NO blank → the fee-extraction pass (extract_v2) maps them to columns
  WITHOUT a box. Complements box-placement.
- Fee "planes": platform_collectible / deposit_bounded / court_only. Interest
  (10%/yr) + attorney fees = court_only (record, never bill). Liquidated
  damages = deposit_bounded then court. Short-notice penalty = deposit_bounded,
  notice_period_rent type.
