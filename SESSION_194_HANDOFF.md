# Session 194 — closed

## Theme

S190 carry-forward: tenant-facing override visibility at lease
signing. When a tenant signs a lease (or terms-change addendum) at
a property in a state with a deposit-interest rate (statutory or
landlord override), the SignPage Review & Submit modal now shows
the rate that will accrue. Closes the visible-to-tenant loop on
the A3 deposit-interest thread for the lease-signing surface.

## What S194 shipped

### Backend — `GET /api/esign/sign/:documentId` returns `deposit_interest_context`

Extended the existing tenant-facing sign endpoint. Response now
includes a `deposit_interest_context` field:

- **`null`** when document type isn't `original_lease` /
  `addendum_terms` (deposit terms don't apply to add/remove tenant
  addendums), OR when property has no state set, OR when the
  state has no statutory rate AND no landlord override for the
  current year.
- **`{ source: 'statutory', state_code, effective_year, annual_rate_pct, statute_citation }`**
  when the property's state has a hardcoded statutory rate.
- **`{ source: 'landlord_override', state_code, effective_year, annual_rate_pct, statute_citation: null, source_notes }`**
  when no statutory rate but the landlord has set an override per
  S190.

Resolution priority matches the rest of the engine: statutory
catalog wins, override is fallback. Year keys to current calendar
year (signing flow happens before any monthly accrual; the rate
shown is what will apply at the first month-end accrual after
move-in).

Document JOIN extended to pull `p.state` and `p.landlord_id` so
both lookups can run inline.

### Frontend — SignPage Review & Submit modal

`apps/tenant/src/pages/SignPage.tsx` Review & Submit modal gains
a deposit-interest information box between the field-summary list
and the UETA legal disclaimer. Hidden when `deposit_interest_context`
is null.

Two copy variants:
- **Statutory:** "State law ({citation}) requires {rate}% annual
  interest on held security deposits. If your lease specifies a
  deposit, it accrues monthly and is paid out with your refund
  at move-out."
- **Landlord override:** "Your landlord has set a {rate}% annual
  interest rate for held security deposits in {state} ({year}).
  Interest accrues monthly and is paid out with your refund at
  move-out."

Modal also gained `maxHeight: 90vh` + `overflowY: auto` so the
extra content doesn't break on small screens.

### Files touched (S194)

```
apps/api/src/routes/esign.ts                                            (GET /sign/:documentId: + property_state/landlord_id JOIN, + deposit_interest_context resolution, + response field)
apps/tenant/src/pages/SignPage.tsx                                      (Review & Submit modal: + deposit-interest info box with statutory vs override copy variants, modal scrollability fix)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/tenant && npx tsc --noEmit` → 0
- No schema migrations
- No frontend changes outside SignPage

## Decisions made (S194)

| Question | Decision |
|---|---|
| Where in the SignPage flow to show the rate? Setup, signing, or review? | Review modal. The setup screen is for signature creation (no document context); the signing screen shows the PDF (no extra context overlay). Review is the moment the tenant pauses to confirm before submitting — best place to surface non-PDF context. |
| Show projected dollar amount based on the deposit value in the lease document? | No, deferred. Dollar projection requires extracting the deposit value from document field values, which is template-dependent and may not be reliable across all lease templates. The rate alone is the actionable info; the tenant can compute their own projection from the lease's stipulated deposit. |
| Show context for `addendum_add` / `addendum_remove` documents too? | No. Those are tenant-roster changes (someone joining or leaving the lease), not term changes. The deposit terms don't change for those. Limit to `original_lease` and `addendum_terms`. |
| Look up the rate at sign-time vs the rate that was active when the lease was originally drafted? | Sign-time (current year). The rate that applies is the one in effect when the deposit is held; sign-time is the closest available proxy. If a landlord drafts a lease in Dec 2026 and the tenant signs in Jan 2027 after a rate change, the new rate applies — that's the correct semantic. |
| Surface the box on the LANDLORD's review surface too? | Skipped this session. Landlord knows their own override (they entered it on Settings); statutory rates are CLAUDE.md-documented. Tenant visibility was the specific S190 carry-forward ask. Landlord-side could be a future polish. |

## Carry-forward — what S195+ should target

### Specific to A3 thread (still open)

- **`properties.deposit_interest_rate_annual` columns audit/drop**
  (S193 discovery). Three columns with zero consumers, likely
  superseded by S188/S190 design. Quarter-session audit.
- **Expand state catalog** — research-heavy. Add CA / IL / RI / IA /
  NH (statutory) etc.
- **Annual rate refresh discipline** — CLAUDE.md addendum or
  dedicated DEPOSIT_INTEREST_PLAYBOOK.md. 15-min task.
- **Landlord-side rate visibility on lease draft preview** —
  parallel to S194 but on the landlord composer surface.
  Half-session if Nic wants symmetry.

### Already-known carry-forward (unchanged)

- `leases.security_deposit` → `lease_fees` deprecation (2-session,
  recon confirmed)
- B3 thread: needs-ack filter, SchedulePage tile badge, hard-gate
  check-in product call
- Primary manager urgency tier (S185 question)
- Owner-financial-escalation pattern (S186 question)
- Other POS tables for property scoping (S192 carry)
- Sublease subsystem (multi-session)
- B1+B2 material-change workflow (multi-session)
- C1 50-state property tax form catalog (multi-session)
- D2 Flex tenant suite (launch-flag gated)
- POS Terminal hardware + EOD
- CSV imports
- E2 npm upgrades
- F1 Marketing rebuild

---

End of S194 handoff.
