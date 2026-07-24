# SESSION 552 HANDOFF — AI agent overhaul (continuation of S551's chat)

Same continuous chat as S551 (Stripe/Checkr/fees — see SESSION_551_HANDOFF.md);
this file captures the agent workstream that followed. Next session: 553.

## Agent overhaul — DONE, all deployed (API build+kickstart each step)
- **Infra**: com.gam.model (:8080 Hermes-4.3-36B MLX) + com.gam.embeddings
  (:8081 bge-large) bootstrapped into launchd (were NEVER loaded — agents
  dead); start-embeddings.sh PATH fix (launchd can't see Homebrew).
- **Eval 58% → 100%** (12/12, held through all later changes). Root causes:
  buildContextBlock's "answer using ONLY the facts below" overrode tools +
  escalation (reframed, groundedAgent.ts); get_landlord_portfolio description
  claimed payout questions (fixed); runner SAFETY NETS added in agentRunner.ts:
  ACCOUNT_DATA_INTENT (tool-less answer to "my lease/deposit/…" → one forced
  retry; model had FABRICATED lease dates) + MONEY_DISPUTE_INTENT (refund/
  double-charge turns must end in escalation). Eval actors now real (alice +
  realestaterhoades). Quantized-model lesson: prompts drift run-to-run;
  deterministic backstops don't.
- **Knowledge**: all 46 articles audited vs code (3 subagents); ~15 corrected
  (SMS ghosts, card-fee-payer lock S513, per-unit-class late fees, instant
  withdrawal 2%/$5, nav lists regenerated, payment-method myths). +17 NEW
  fact-verified articles (tenant: amenities, utility charges, FIFO payment
  application, work trade, 2FA(shared), applicant bg check; landlord:
  amenities setup, meter billing, rent roll, inspections, entry notice,
  deposit return, ending leases, work trade, POS, reservations+storefront).
  **Flex article** (flex-advantage-interest.md, Nic-constrained): interest
  form ONLY, no timing/availability promises; matching hard rule added to
  BOTH tenant profiles (Ava+Samantha) — landlord agents never mention Flex.
  Now 63 articles / 178 chunks. RULE going forward: product changes update
  knowledge articles in the same session.
- **New tools (registered in tools/index.ts + tenant profiles)**:
  respond_to_entry_request (grant/deny via shared service
  services/entryRequestRespond.ts — extracted from the route, both paths
  identical), get_my_termination_quote (live-verified: quoted alice's real
  $2,300), get_my_balance_breakdown (FIFO where-did-my-payment-go),
  get_my_amenities + request_amenity_reservation (uses route-exported
  helpers loadArea/validateWindow/fireAmenityAlert + services/commonAreas;
  instant-book areas BILL immediately — agent must confirm fee first).
- **Booking auto-apply (Nic)**: requestBookingChange — late_checkout/
  early_checkin/extra_night auto-approve when findStayConflict says the
  master schedule has room (extra_night extends unit_bookings +1 night);
  conflicted + 'other' fall back to host-decides. Auto rows: status
  'approved', resolved_by NULL (= system). Notifications fan out via NEW
  services/staffNotify.ts findStaffWithPermission (unions 3 staff scope
  tables on permissions jsonb + property scope) to everyone holding
  bookings.change_requests/resolve_change_request/view for the property +
  owner — front desk hears directly (Nic: owner must never relay).
- **Product fixes shipped en route**: maintenance approval ceiling ENFORCED
  (Nic Option B: over-ceiling staff approval → 403 + stays awaiting_approval
  + landlord notified "X tried to approve $Y above their $Z limit"; unknown
  estimate counts as over; 3 tests); tenant Work Trade page WIRED (was
  unreachable — no route/nav; now /work-trade in tenant portal, deployed,
  live-verified; Nic: launch feature, trade workers exist); tenant
  MaintenancePage awaiting_approval raw-enum label fixed (S538).

## Remaining agent queue (approved by Nic, not yet built)
1. Landlord amenity pair: get_pending_amenity_requests + decide tool
   (extract decide logic from routes/commonAreas.ts:301 into service first —
   it uses lockArea/findApprovedConflict, compact).
2. Service-interruption tools (landlord create/read; use staffNotify fan-out).
3. Guest amenity booking via stay link (publicPropertyBooking.ts:380 —
   fee disclosed before confirm).
4. Tenant amenity CANCEL deliberately skipped (heavy refund logic inline in
   route; portal handles it; article explains 48h refund rule).
5. Eval expansion to ~40 scenarios incl. guest/booking agent + new tools.
6. Admin → Agent Analytics page (agent_interaction_logs has latency_ms,
   tokens, tools, escalations per turn — usage/peak/shed dashboards are
   queries; shed = "buy bigger hardware" alarm).
7. Knowledge housekeeping: merge near-duplicate what-is-gam-and-how-to-reach-
   human/support articles.

## Watchouts
- Eval run: cd apps/api && LLM_ENDPOINT=http://localhost:8080/v1 LLM_MODEL=
  /Users/nicholasrhoades/models/Hermes-4.3-36B-6bit-mlx EMBEDDINGS_ENDPOINT=
  http://localhost:8081/v1 EMBEDDINGS_MODEL=bge-large-en-v1.5 DB_* npx
  ts-node -T src/services/agents/agentEval.ts. Run after ANY prompt/tool/KB
  change. Re-ingest: same env, ingestKnowledge.ts.
- agentEval actors: alice (real data) — eval tools READ real demo rows; the
  send_bulk_message landlord scenario uses profileId all-zeros (no sends).
- amenityTools.ts imports loadArea/validateWindow/fireAmenityAlert FROM
  routes/commonAreas.ts (route exports them; acyclic — routes never import
  agent code). If those helpers move, update the import.
- Model services take ~1-2 min to load 27GB after kickstart.

## Cross-workstream state (see SESSION_551_HANDOFF.md for detail)
Stripe Connect: STILL in Stripe-side review; probe = POST /v1/accounts.
Checkr/Victor: entity re-registration + Essential pricing + vetting
requirements pending. Oak Park N2/N3: Nic deferred until Stripe/Checkr land.
