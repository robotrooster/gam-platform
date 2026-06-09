Session 29c-2-C Handoff — Onboarding Entity Schema + Parser Foundation (incomplete)

Date written: April 28, 2026
Branch: main (uncommitted — Nic handles git locally)
Schema: 9 new tables + 4 new columns landed live AND in schema.sql
TSC baseline: shared clean, landlord clean, api has 4 NEW errors from this session + 1 RESURFACED rot from S19
API boot: not booted this session

SESSION PURPOSE

S29c-2-B left two pieces off: the parser, and the resolve mechanism. This session was scoped to ship both. Reality: shipped schema for everything the parser writes to (9 entity tables, 4 column extensions), shipped the ParserOutput type contract extension, shipped the entire parser foundation (pdfjs-dist integration + audit trail extraction + anchor matching + per-field extractors with confidence scoring). Resolve mechanism + endpoint + stub replacement DID NOT ship. Parser has 4 known bugs surfaced but not fixed.

Next session = S29c-2-D = parser finish + resolve + wiring.

ARCHITECTURAL DECISIONS LOCKED THIS SESSION

These are non-negotiable going forward and override anything in earlier handoffs that contradicts.

1. Parser is advisory, never authoritative. Auto-resolve is GONE. Every limbo intent — regardless of parser confidence — passes through landlord click before resolve fires. The Build lease button is mandatory, not bypassable. parser_status='parsed' means "form is mostly green, landlord still confirms"; it does NOT mean "auto-build."

2. Critical-field set defined: tenants[0].firstName, tenants[0].lastName, tenants[0].email, unit.unitNumber, lease.leaseStart, lease.leaseEnd, lease.monthlyRent. Block-severity flags on these → parser_status='mismatch'. Block-severity on non-critical → still 'parsed' with confirm-severity flags attached. Wrong values on critical fields are real money / missed activations; non-critical can be patched post-onboarding.

3. Confidence tiers: 0.95+ green (looks-good check), 0.70-0.95 yellow (verify glance), <0.70 red (must touch). Tier mapping is centralized in extractors.ts scoreConfidence(). UI implications surfaced in S29c-2-D scope.

4. Confirm UI is side-by-side PDF + extracted fields. Existing pdf.js viewer modal from S29c-2-B is reused. Per Nic's framing: "maybe parse is right and pdf is wrong and unnoticed" — landlord can override the document itself, surfaced as explicit override action, not just an edit. Builds in S29c-2-D.

5. Parser is migration tool, not steady-state. Existing-tenant onboarding only. Once a landlord is onboarded, GAM-built templates handle everything. Optimization priority: landlord time-to-onboarded, not parser perfection. Bulk PDF onboarding is NOT a real workflow (CSV is bulk; PDFs are one-at-a-time legal docs). Bulk-confirm UI was scoped out and removed from deferred list.

6. No third-party AI APIs on tenant data. Standing rule held. Parser is pure heuristics: pdfjs-dist for positional text + regex anchor matching + value-shape filters. Template fingerprinting (S29c-2-E) extends this with auto-learned template anchors per landlord — still no AI, just learned from landlord-confirmed leases.

7. PDF positional extraction is the right tool. pdf-parse (concatenated text, no positions) cannot anchor floating e-sign overlay values to printed labels because values appear in content-stream order, not visual order. pdfjs-dist's getTextContent() exposes per-item transforms (x, y, font). This is the only path that works on real e-sign output (Dropbox Sign, DocuSign, Adobe Sign).

8. references in tsconfig require a build script to do anything useful. apps/api/tsconfig.json had `references: [{path: '../../packages/shared'}]` but shared has no build script. references was paving over real rot from S19. Removed this session. The S19-deferred `auth.ts @gam/shared rootDir violation` resurfaced as expected. Rule: don't add tsconfig references unless the referenced package has a build that runs.

WHAT SHIPPED — SCHEMA

apps/api/src/db/schema.sql appended ~290 lines (file now ~974 lines). All applied to live DB AND schema.sql in the same paste per standing rule. Single transaction, all IF NOT EXISTS, partial-failure rolls back.

Existing-table extensions:
- tenants.date_of_birth (date)
- tenants.mailing_address (text)
- leases.subleasing_allowed (text NOT NULL DEFAULT 'with_consent', CHECK in 'prohibited'/'with_consent'/'allowed')
- leases.extraction_extras (jsonb) — catchall for parser-extracted fields not yet promoted to typed columns

9 new tables, all with FKs/indexes/updated_at triggers wired:

- tenant_identifications — DL/passport/state ID per tenant. id_type CHECK in drivers_license/state_id/passport/military_id/tribal_id/permanent_resident_card/other. Multiple per tenant allowed; is_primary boolean.
- emergency_contacts — per tenant, multiple. name + phone + email + relationship + sort_order.
- mobile_homes — tenant-owned, persists across leases. current_owner_tenant_id + unit_id (both nullable for "removed" state). year/make/model/serial_number/hud_label_number/length_ft/width_ft/manufactured_date/removed_at/removed_reason. AZ Mobile Home Parks Act Clearance for Removal flow lives at app level, not schema.
- rvs — parallel to mobile_homes. Same shape: current_owner_tenant_id + unit_id. year/make/model/vin/length_ft/num_slides/hookup_class (CHECK in 20amp/30amp/50amp/shore_only/none)/license_plate/plate_state/plate_expiry_date.
- lease_vehicles — non-RV vehicles for parking. lease_id (CASCADE) + owner_tenant_id (SET NULL). vehicle_type CHECK in car/truck/suv/van/motorcycle/scooter/utility_trailer/boat/other. parking_spot_assignment text.
- lease_pets — species CHECK in dog/cat/bird/reptile/fish/small_mammal/livestock/other. service_animal + emotional_support flags. license_county/license_number/vaccinations_current/vet_name/vet_phone. Pet fees billed via existing lease_fees table, NOT this one.
- lease_occupants — non-tenant occupants. is_minor + requires_background_check + background_check_id (FK to background_checks SET NULL). For occupancy compliance + adult-occupant BG check tracking.
- liability_insurance_policies — lease-attached. carrier_name + policy_number + expiry_date + document_url. Renewal-reminder workflow lives at app level when wired.
- subleases — payment-routing arrangement, NOT a parallel lease. master_lease_id (RESTRICT) + sublessee_tenant_id + sublessor_tenant_id + sub_monthly_amount + master_share_amount. Status pending/active/terminated. Distinct-parties + share>=0 + sub>0 CHECK constraints. Full subsystem deferred — see deferred section.

Primary-dwelling status is DERIVED, not stored. An RV or mobile home with an active lease on its unit IS the dwelling. Bookings ≤30 days live in unit_bookings, never in leases. The data model already encodes the long-term/short-term distinction; no is_primary_dwelling flag needed.

SCHEMA DECISIONS WORTH PRESERVING

- Vehicles vs RVs are separate tables. Per Nic: "separate vehicles from rvs. some people live in them permanently." RV-as-dwelling has different ops semantics (hookup class, length for spot fit, can be primary dwelling) than parking-only vehicles.
- Mobile homes are unit-attached, not lease-attached. Same home spans multiple leases when tenants change. current_owner_tenant_id can change without unit_id changing.
- Subleasing rule (locked from this session's discussion): tenant pays full sub-rent through GAM. Landlord-first allocation: master_lease's owed amount routes to landlord first, residual to sublessor. Partial sub-rent payments → landlord whole before sublessor sees a cent. Master lease late fees / NSF / notice fees all hit landlord ledger first. If master ends, sublease ends automatically. Sublessor cannot evict / file detainer / send notices. Sublessor portal access = read-only ledger view (sublessee paid X, landlord received Y, sublessor disbursement Z). Sublease document governs sublessor↔sublessee terms; conflicts between sublease and master, master prevails. None of this is built — schema only this session.

WHAT SHIPPED — SHARED TYPES

packages/shared/src/index.ts grew by ~120 lines, now ~1864 lines. Five in-place edits + 9 new types + 5 const arrays + 5 runtime guards. All via must_replace pattern with anchor uniqueness checks.

In-place edits:
- ParserExtractedUnit: added unitType? (UNIT_TYPES value)
- ParserExtractedLease.leaseType comment fixed: was "residential/storage/commercial/rv_*" (drift), now "LEASE_TYPES value (month_to_month/fixed_term/nnn_commercial)"
- ParserExtractedTenant: added dateOfBirth?, mailingAddress?, identifications?, emergencyContacts?
- ParserExtractedLease.autoRenewMode comment fixed: was "'fixed'|'m2m'" (drift), now DB CHECK values "extend_same_term|convert_to_month_to_month"
- ParserExtractedLease: added subleasingAllowed?

ParserOutput extension — added optional sections: vehicles[], rvs[], mobileHome?, pets[], additionalOccupants[], liabilityInsurance?, sublease?, extractionExtras? (Record<string, unknown>). Per S29c-2-B contract held: every field still wraps in ParserExtractedField<T> with confidence/rawText.

5 new const arrays mirroring DB CHECK constraints exactly (drift = bug rule):
- VEHICLE_TYPES (9 values)
- PET_SPECIES (8 values)
- RV_HOOKUP_CLASSES (5 values)
- ID_TYPES (7 values)
- SUBLEASING_POLICIES (3 values)

9 new ParserExtracted* types: Vehicle, Rv, MobileHome, Pet, Occupant, Identification, EmergencyContact, LiabilityInsurance, Sublease (advisory only — parser flags `detected:true` but landlord confirms before subleases row inserts).

5 new runtime guards: isVehicleType, isPetSpecies, isRvHookupClass, isIdType, isSubleasingPolicy.

WHAT SHIPPED — PARSER FOUNDATION

apps/api/src/lib/pdfText.ts — pdfjs-dist v3 wrapper. extractPositionedText(buf) returns ExtractedPdf{pageCount, pages: [{pageNumber, width, height, items: [{text, x, y, x2, fontName}]}]}. v3 legacy CJS build (v4+ is ESM-only and breaks under tsx). standardFontDataUrl wired correctly to packages/shared/standard_fonts/ (v3 ships them at the package root, NOT under legacy/build/ — discovered via recon). DOMMatrix/Path2D polyfilled via @napi-rs/canvas (Rust napi prebuilds, no Cairo/Pango Homebrew dep). Polyfill block runs BEFORE the require('pdfjs-dist') because pdfjs probes for these globals at module init time. Three production warnings eliminated this session: Cannot polyfill DOMMatrix, Cannot polyfill Path2D, fetchStandardFontData failed. All clean now.

apps/api/src/jobs/leaseParser/itemJoin.ts — joinPageItems (strict: same y + same font + small gap) and joinPageItemsRelaxed (same y + small gap, ignores font). Strict for spatial calculations, relaxed for label-text reading. pdfjs splits text by font subset boundaries; joining is required before any meaningful regex.

apps/api/src/jobs/leaseParser/auditTrail.ts — isAuditTrailPage(page) for filtering, extractAuditTrail(pages) returns AuditTrailExtraction{detected, documentTitle?, signers: SignerInfo[], startPage?}. SignerInfo includes name+email+signedAt+ipAddress. Pattern is "Signed by NAME (EMAIL)" which generalizes across Dropbox Sign / DocuSign / Adobe Sign. Per-signer enrichment uses scope-by-next-signer windowing (not fixed-character) to prevent IP/timestamp bleed between signers — earlier bug fixed mid-session. Title extraction has labeled fallback (Title/Subject/Agreement-name patterns) plus positional fallback (highest-y item passing denylist) for Dropbox Sign tamperproofed PDFs that don't print "Title" as a label. Marci PDF: extracts both signers with correct emails + IPs + timestamps + title "New Lease Agreement - 22658 Highway 89 - MH #6". Production-grade.

apps/api/src/jobs/leaseParser/anchors.ts — directed extraction primitives. After a failed generic-index approach (S29c-2-C mid-session pivot — generic index can't disambiguate fragmented labels from prose-with-colons), settled on findFieldByLabel(page, opts) and findAllFieldsByLabel(page, opts).

Algorithm: for each pattern-matching prose item, compute label-end x via proportional position, find candidate values matching spatial mode (right_same_line / below_same_x / right_then_below) and shape regex, return closest-to-label-end. Multi-value lines like "Year: ___ Make: ___ Serial: ___" are correctly disambiguated because each label query lands the value nearest to its OWN label end, not the leftmost or rightmost on the line.

Three filter-correctness fixes during the session (all in candidates filter):
- !opts.labelPattern.test(it.text) — values can never contain the label that anchors them; this exclusion is required because pdfjs may emit the same label text as both prose item and strict-joined fragment.
- !isNoiseValue(it) — pure underscore/whitespace items, stray punctuation runs from font-subset splits, are never legitimate values. (BUG: function body partially missing in current state — see Known Bugs.)
- Y_SAME_LINE_TOLERANCE = 6pt (loosened from 4) — e-sign overlays drift up to ~5pt from the underscore baseline.

isLabelLike(item) — terminal-colon requirement (not just alphabetic content). Form labels end with `:` followed by whitespace/underscores or EOL. This was the load-bearing fix for distinguishing labels from body prose like "Liability Insurance" (heading, no colon → not a label).

effectiveX2(item) — proportional colon-position computation. Lets same-line anchor matching work when label and value share a line and the label's underscore furniture visually extends past the value.

PROVEN ON MARCI NEELD PDF (the test corpus): 19/19 standalone field probes correct + audit trail title + 2 signers + IPs + timestamps. Probe results captured in conversation; preserve them as the regression baseline for S29c-2-D.

apps/api/src/jobs/leaseParser/coerce.ts — 9 type coercion helpers. coercePhone (10 or 11 digits → 10-digit string), coerceDateMDY (MM/DD/YYYY → ISO), coerceDateFromText ("1st May 2024" → ISO with month-name table), coerceCurrency ($-tolerant, N/A → null, range-bounded), coerceInt, coerceTermInMonths ("1 Year" → 12), splitName, splitNameAndPhone (Kevin Black 303-949-2683 → {name, phone}), coerceText, coerceTextOrNA (N/A → null vs preserved). Coerce-failure → field omitted from ParserOutput, NOT junk-value emitted.

apps/api/src/jobs/leaseParser/extractors.ts — 19 per-field extractors + 1 generic extractField<T> wrapper. Confidence scoring centralized in scoreConfidence({matchKind, distanceFromLabelEnd, shape}) with documented penalty model: base 0.95, -0.05 for below match, -0.05 each for distance >50/>100, -0.10 loose shape, -0.20 no shape. Floor 0.30, ceiling 0.99 — never claim certainty. Coverage:
- Identity: extractTenantNameSplit, extractTenantPhone, extractTenantDateOfBirth, extractTenantMailingAddress
- Identifications: extractDriversLicense
- Emergency: extractEmergencyContact (composes findFieldByLabel + splitNameAndPhone)
- Insurance: extractLiabilityInsurance (carrier + policy)
- Mobile home: extractMobileHome (year/make/model/serial composition with proportional x-split for make-vs-model on the multi-value line)
- Unit: extractUnitNumber (inline-prose label "Space No. ___"), detectUnitType (keyword-count heuristic across all body text → highest count wins; defaults apartment with low confidence)
- Lease terms: extractFixedTerm, extractLeaseStart, extractLeaseEnd, extractMonthlyRent, extractSecurityDeposit
- Lease behavior (prose-pattern detection): detectAutoRenew, detectNoticeDays, detectLateFees, detectSubleasingPolicy
- Property: extractPropertyNameAndAddress (regex against "this park, NAME, ADDRESS ('Premises')" pattern)
- Occupants: extractAdditionalOccupants (split + dedup against primary tenant)

apps/api/src/jobs/leaseParser/index.ts — parseLease(pdfBuffer): Promise<ParseResult>. Pure function: takes PDF, returns ParseResult{status, output, flags, auditTrail}. NO database access. NO landlord-typed-identity comparison (that's runParserJob's job in the orchestration layer that has intent context — runParserJob is S29c-2-D scope). Audit trail email matching by signer name lookup: tenant email is whichever audit signer matches the body-extracted tenant name; falls back to "second signer by timestamp" heuristic if exactly 2 signers and no name match. Status decision: critical block flags → mismatch, else parsed. PARSER_VERSION = 'gam-parser-0.1.0'.

apps/api/scratch/test-parse.ts — end-to-end smoke runner. npx tsx apps/api/scratch/test-parse.ts <pdf>. Pretty-prints status + audit trail + every field with green/yellow/red confidence tiers + all flags + mobile home + insurance + occupants. Useful for regression testing future parser changes.

KNOWN BUGS — UNFIXED THIS SESSION

These are the day-one targets for S29c-2-D. Diagnostic data already captured in conversation; do not re-run diagnostics, just fix.

A. isNoiseValue function body PARTIALLY MISSING from anchors.ts. Last-paste Python edit did not land cleanly (no error visible at edit time but the function was not visible in grep afterwards). State of file is uncertain — view it before patching. Symptom: scratch trace fails at `import { isNoiseValue }` with "is not a function". The findFieldByLabel candidates filter still references isNoiseValue(it), which means findFieldByLabel ALSO crashes if the function is fully absent. But parseLease via tsx ran end-to-end via test-parse.ts, which means the function IS reachable somehow at runtime — probably present but missing the `export` keyword. Fix: view anchors.ts, locate the function, ensure `export function isNoiseValue` is the declaration. If function body is missing entirely, restore from this snippet:

```ts
export function isNoiseValue(item: JoinedItem): boolean {
  const t = item.text.trim()
  if (t.length === 0) return true
  if (/^[_\s]+$/.test(t)) return true
  if (/^["'\(\)\u201C\u201D\u2018\u2019.,:;\-]+$/.test(t)) return true
  return false
}
```

B. extractors.ts — 4 strict-null TSC errors:
- line 104: extractTenantMailingAddress's coerceText call — coerceText returns string | null but extractField<string> wants string. Fix: change generic to <string | null> OR adjust extractField to handle null returns explicitly (recommended — null is a real "extracted but empty" signal).
- line 165: same pattern, extractEmergencyContact
- line 438: hit.value possibly null in extractAdditionalOccupants — guard with `if (!hit) return []` (already there) is structurally correct but TS doesn't narrow through the closure. Annotate as `hit.value!` OR restructure with intermediate const.
- index.ts line 76: lastName.value possibly null in audit-trail email matching — same guard issue.

C. extractors.ts line 438 splitter — typed `(s: string) => s.trim()` last paste, may need ` (s: string | undefined)` if split union surfaces.

D. Property name/address regex misses Marci PDF. Diagnostic prose: `"this park, Oak Park Motel and RV, 22658 Highway 89 Yarnell AZ 85362 ("Premises")"`. Current regex requires `("Premises` adjacent; actual text has whitespace and curly quotes. Fix: tolerate whitespace + curly quotes between address and "Premises". Pattern: `/(?:this|the)\s+(?:park|community|premises|property)\s*,\s*([^,]+?)\s*,\s*([^"\u201C(]+?)\s*[("\u201C]\s*Premises/i`.

E. Late fee amount regex misses. Diagnostic prose: `"A late charge of Five dollars ($ 5 .00) per day"`. pdfjs splits the dollar amount across font subsets — there's whitespace inside `$ 5 .00`. Current `\$([\d,]+(?:\.\d+)?)` doesn't tolerate whitespace inside. Fix: `\$\s*([\d,]+(?:\s*\.\s*\d+)?)` and post-coerce strip whitespace from captured group. Same fix for $35 charges.

F. Late fee grace days regex misses. Diagnostic prose: `"if not remitted by the   5 th   day"` — `5 th` has whitespace between digit and ordinal suffix. Current regex `(\d{1,2})(?:st|nd|rd|th)?` requires no-whitespace adjacency. Fix: `(\d{1,2})\s*(?:st|nd|rd|th)?\s+day` and strip whitespace.

G. Notice days regex misses. Diagnostic prose: `"at least thirty (3 0) days before the expiration"` — digit `30` is split as `3 0`. Two paths: tolerate whitespace inside digit run via `(\d{1,3}(?:\s*\d)*)` plus normalize, OR fall back to spelled-out word ("thirty" → 30) via a small word-to-number map. Hybrid is best. Pattern: prefer digit form with whitespace tolerance; fall back to MONTHS-style number-words map for {ten, fifteen, twenty, thirty, sixty, ninety}.

H. Emergency contact extractor returned wrong value (the prose paragraph below the label) when run via parseLease end-to-end, despite working perfectly in standalone trace. Trace was about to show which filter rejects Kevin Black at y=414.7 (Δy=5.1 from label at y=409.6, tolerance is 6 — should pass) but crashed at isNoiseValue import. Fix isNoiseValue (item A), re-run trace, read the per-filter PASS/FAIL output, fix whichever filter is rejecting Kevin Black. Most likely cause: the proportional-position labelEndX calculation puts label end at x=143.1 (computed correctly per trace before crash) but Kevin Black's strict-joined item at x=153.8 may be failing some other filter. Trace will show which.

I. Security deposit returns 0 with low confidence when document has "N/A". This is wrong design — N/A is a legitimate landlord answer ("no security deposit") and should preserve as 0 with HIGH confidence. coerceCurrency returns null for N/A; extractSecurityDeposit currently substitutes `{value: 0, confidence: 0.40}` as a fallback. Better: preserve null (omit field from ParserOutput) OR substitute `{value: 0, confidence: 0.95, rawText: 'N/A in document'}`. Decision pending — ask Nic. The principle of "honestly empty" was discussed but the implementation didn't follow through.

J. apps/api/tsconfig.json had `references: [{path: '../../packages/shared'}]`. Removed this session because shared has no build script (paths mapping to src/index.ts is what actually works). This SURFACED a known-deferred S19 TSC rot: `auth.ts @gam/shared rootDir violation`. The S19 deferred-list entry is now active (TSC errors visible) but does NOT block tsx execution. Decision for S29c-2-D: leave as-is (rot was already there, just hidden), OR fix the rootDir issue properly (involves restructuring tsconfig.json's rootDir or moving auth.ts imports — not a 5-minute fix). Recommended: leave as-is, S29c-2-D has enough load-bearing work without taking on this rot.

WHAT'S QUEUED FOR S29C-2-D

Immediate:
1. View anchors.ts, fix isNoiseValue export/body.
2. Patch the 4 strict-null TSC errors in extractors.ts + index.ts.
3. Patch the 4 prose-pattern misses (D, E, F, G above) using diagnostic data already captured.
4. Re-run trace on emergency contact (H) and patch the rejecting filter.
5. Resolve N/A handling on securityDeposit (I) — ask Nic for direction.
6. Add additional test PDFs beyond Marci. Goal: tune patterns generically, not Oak-Park-specifically. At minimum: a DocuSign-output PDF, an Adobe Sign PDF, a typed-inline (no e-sign overlay) PDF, a multi-tenant PDF.

After parser is stable on test corpus, the C2 work that didn't ship this session:

7. apps/api/src/jobs/leaseParser/runParserJob.ts — orchestration layer between parseLease and the intent record. Reads pending_tenant_intents.imported_pdf_url, fetches PDF buffer, calls parseLease(buf), compares parser output identity (firstName + lastName + email) against intent's landlord-typed identity (from intent.tenant_id → tenants → users), generates identity_mismatch flags if they disagree, writes parser_output (JSONB) + parser_status + parser_flags back to the intent. Replaces schedulePendingParserStub in landlords.ts. Schedule it the same way the stub was scheduled (setTimeout in-process; queue infra is later).

8. apps/api/src/jobs/leaseParser/resolveIntent.ts — shared function. Single caller path: from POST /resolve endpoint with landlordOverrides body. NEVER auto-callable per locked architecture. Mirrors /commit lease-creation pattern at landlords.ts:1527-1653: validate intent state (parsed/mismatch/error allowed; not_uploaded/parsing/resolved rejected) → merge ParserOutput + landlordOverrides → re-run identity conflict checks (cross-landlord active lease, same-landlord active lease) → INSERT INTO leases with lease_source='imported' + imported_pdf_url → UPDATE users SET email_verify_token (deferred token from intent creation finally fires) → INSERT INTO lease_tenants → write entity rows (mobile_homes, lease_vehicles, lease_pets, lease_occupants, liability_insurance_policies, tenant_identifications, emergency_contacts) per ParserOutput → write extractionExtras to leases.extraction_extras → promote PDF from uploads/lease-pdfs-pending/ to uploads/leases/ (after DB commit; rolling back rename is messier than rolling back DB) → UPDATE pending_tenant_intents SET parser_status='resolved' + resolved_lease_id + resolved_at → fire emailTenantOnboarded.

9. POST /api/landlords/me/pending-tenants/:intentId/resolve — endpoint, calls resolveIntent. Body: ParserOutput-shaped landlordOverrides (every field optional; merged on top of stored parser_output). Returns {success, data: {leaseId, tenantUserId, ...}}.

10. Replace schedulePendingParserStub call in landlords.ts with the new runParserJob call.

11. Frontend confirm UI on PendingTenantsPage. Builds on existing FlagsDetail expansion in S29c-2-B IntentCard. Side-by-side: PDF viewer modal on left (existing), per-field editable form on right with confidence-tier styling (green check / yellow caution / red flag). "Override document" affordance per field for the typo-in-PDF case. Single "Build lease" button at bottom POSTs to /resolve with merged overrides. Critical: every field shows pre-filled — landlord taps to dispute, doesn't type from scratch.

S29c-2-E AND BEYOND

Template fingerprinting — moved UP from "deferred nice-to-have" to "next priority after parser works." For migration onboarding speed this is the highest-leverage feature: by lease #5 from a given landlord with same template, all anchors are known and confidence is high enough for landlord to scan-and-click. New table parser_templates(landlord_id, layout_fingerprint, anchors JSONB, version). Layout fingerprinting strategy open at recon time — likely hash of {first-page word frequencies + page count + dimensions} but verify against test corpus. Auto-record anchors on resolve from parsed/mismatch intents so future parses fast-path. Template-first lookup in runParserJob before falling through to heuristics.

Sublease subsystem (full build, dedicated session). Schema landed S29c-2-C. Everything else deferred:
- Payment splitter logic (landlord-first allocation across rent + fees in priority order)
- Sublessor read-only portal view (ledger of sublessee paid X / landlord received Y / sublessor cut Z)
- Sublease document parsing (treat sublease PDFs through same limbo→parser→resolve flow as master leases, write to sublease record's terms)
- Master-vs-sub conflict detection at creation (flag contradictions, master prevails)
- Sublease termination cascade when master lease ends (auto-terminate, freeze sublessor disbursements)
- Open question: how sub-late-fees vs master-late-fees allocate when sublessee is partial-paid
- Open question: 1099 reporting for sublessor income (intersects with GAM Books multi-party reporting)
- UI: sublessor as a tenant role with constrained landlord-side view (sees sublease only, never master lease detail)

Test corpus expansion. S29c-2-D needs PDFs from DocuSign, Adobe Sign, typed-inline (no overlay), scanned-paper (likely fails — error path), multi-tenant. Each tunes regex generality. Confidence in algorithm grows with each successful new format.

Schema drift bug. Pre-existing from S29c-1. Live DB has columns schema.sql doesn't (older S29c-1 entries; pending_tenant_intents IS in schema.sql; S29c-2-C entries ARE in schema.sql). Dedicated session to diff live DB against schema.sql, back-fill missed ALTERs as ALTER TABLE ADD COLUMN IF NOT EXISTS, verify a fresh migrate produces a working DB. High priority because new-developer onboarding is broken until then. Standing pattern in the meantime: every schema change applied to BOTH live DB AND schema.sql in same paste.

E-sign /files/:filename auth gap. GET /api/esign/files/:filename serves any PDF to anyone with the filename. Pending-intent PDF endpoint (S29c-2-A) was built behind Bearer auth from the start; e-sign hole still exists. Same dedicated session as schema-drift fix or its own.

pdf.js loader extraction. Now duplicated 5 times (tenant LeasePage, tenant SignPage, landlord SignPage, landlord ESignPage, landlord PendingTenantsPage). When the confirm UI lands in S29c-2-D it'll be a 6th site. Extract to a usePdfJs() hook or <PdfViewer> component in packages/shared, refactor all sites. Mechanical. Adding 6th site is fine until then.

Optional CSV-typed lease priors. When a CSV row routes to limbo, the rent/dates the landlord typed are discarded. Future enhancement: stash CSV-supplied lease fields in parser_output as a "user-provided" priors layer for the parser to compare against. Helps the parser flag mismatches between what landlord typed and what the PDF says. Out of scope for S29c-2-D unless parser strategy benefits.

Punch-list-resubmit limbo dispatch (carryforward from S29c-2-B). Today, fixing identity blockers in the punch list and resubmitting goes through /commit, which still rejects rows with lease blockers. Adding limbo dispatch to punch-list submit means pure-lease-blocker rows after fix go to limbo automatically. Edge-case complexity for an edge-case scenario.

CARRIED-FORWARD DEFERRED LIST (active, not new this session — maintaining for handoff completeness)

Tenant-pool endpoint — trivially buildable on top of tenants.onboarding_source. Single query returning onboarded plus applied tenants scoped to landlord. Now genuinely unblockable since onboarding rails ship real tenant rows.

Platform-specific CSV import mappings (Buildium, AppFolio, DoorLoop, Yardi, RentManager, Propertyware, Rentec Direct, TenantCloud, plus 1-2 TBD by Nic). Pure additive: extends source param dispatch plus per-platform column-name translation table.

tenants.background_check_status / background_check_id columns missing but routes/background.ts writes to them. UPDATEs silently throw, swallowed by next(e). BG status lives correctly on background_checks table directly. Dedicated session: add columns plus backfill, OR rip the stale UPDATEs.

5 of 8 npm audit vulnerabilities (nodemailer pending email consolidation; uuid via node-cron plus svix plus resend pending major-version session for node-cron).

Tenant-pool picker (no free-text email) plus unit picker with consent rule plus backend enforcement on POST /esign/documents — now unblocked by onboarding rails. Backend enforcement: POST /esign/documents rejects occupied-unit sends without full active-tenant roster.

Extract void cascade switch into shared helper (currently duplicated between routes/esign.ts manual void and jobs/scheduler.ts auto-void).

Wrap POST /sign/:documentId in transaction.

POST /esign/documents should also reject executionFailed docs.

Notifications schema rebuild (its own dedicated session per Nic).

Witness in send modal.

Tenant draft persistence (autosave fieldValues to server) — loses progress on tab close.

Tenant decline path with reason plus landlord notification.

Tenant view-only re-open of executed/in-flight docs.

Movie-font signature styles to professional fonts (branding decision).

Two parallel email systems consolidation (services/email.ts Resend vs lib/email.ts nodemailer).

3 backup files cleanup (s19backup, s20backup, s21backup in routes/).

Source PDF path resolution rebuild (currently split('/').pop() — fragile).

Initials lock-to-name (low priority edge case).

Properties endpoint $9 placeholder plus missing amenities column.

PM subsystem (full build or rip pm.ts).

GAM Books AZ-specific tax logic genericization.

Master Schedule finish-or-strip.

ReportsPage endpoint build (GET /api/reports/summary).

Team UI rebuild (single team_member_scopes table).

S23d Tier 1 CHECK migration: 11 of 14 still pending Session B.

Permission gating audit across landlord portal.

Short-term booking acknowledgment docs on unit_bookings.

Payment-method surcharge passthrough at property level.

Consolidated landlord-side ACH pull optimization.

Guarantor/cosigner billing flow.

Flex Suite reintroduction (post-capital, post-legal review).

Property late-fee edit confirmation modal with addendum/notice-period reminder.

Lease-change addendum workflow with legal notice timing.

Deposit interest accrual engine.

Landlord disbursement engine that nets tenant-owed deposit interest.

leases.security_deposit cleanup (move to security_deposits — NOT lease_fees).

S26a catch-up window admin endpoint (POST /admin/invoices/backfill).

lease_fees.due_timing='move_out' and 'other' not consumed by any generator yet.

Branch hygiene: feature/gam-books deletion/rename.

Email-failure surface to landlord UI. Spans /commit (S29c-1) and inherits through /onboard-tenant-pending plus /resolve when activation email lands at resolve time. Should appear in onboarding history / dashboard so landlord can resend or share URL directly.

TSC rot from S19: admin.ts AppError import (3 sites), announcements.ts pool import, auth.ts @gam/shared rootDir (NEWLY VISIBLE this session — was paved over by tsconfig references), background.ts vision unknown access errors, fitness.ts AuthRequest vs AuthPayload, units.ts:395 .id on AuthPayload. Boots via tsx tolerance.

NEW STANDING RULES FROM THIS SESSION

1. Don't add tsconfig references unless the referenced package has a real build. references without build is decorative; it pretends to integrate while paving over rot.
2. pdfjs-dist standard fonts ship at the package ROOT (packages/shared/standard_fonts/), NOT under legacy/build/. require.resolve gives the legacy/build/pdf.js path; go up the right number of dirs.
3. Polyfills for module-init-time globals (DOMMatrix, Path2D, etc.) MUST run before the require() of the consuming module. Polyfilling after-import is too late.
4. When pdf-parse's concatenated text doesn't have what you need, pdfjs-dist's getTextContent() does. Do not try to add positions to pdf-parse output; it doesn't preserve them.
5. Generic indexing of PDF text into a label-keyed map fails on form documents because pdfjs splits labels across font subset boundaries. Use directed extraction (per-field label pattern + per-field shape regex + per-field spatial mode) instead.
6. When isLabelLike check is too loose, terminal-colon requirement separates labels from headings/body. Every form label has the colon; section headings and body prose don't.
7. Underscore-extended labels need effectiveX2 for proportional colon-position calculation. Raw x2 (visual right edge of underscore furniture) breaks same-line anchor matching.
8. e-sign overlay drift is real. ~5pt above baseline is common. Y_SAME_LINE_TOLERANCE of 6pt is the floor.
9. Per-signer enrichment in audit trail extraction needs slice-to-next-signer scoping, not fixed character windows. Otherwise IPs/timestamps bleed between signers.

End of S29c-2-C handoff.
