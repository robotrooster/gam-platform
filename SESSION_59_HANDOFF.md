Session 59 Handoff — Background-check subsystem build + AZ-policy rip-pass + acks reset

Date: April 30, 2026

WHAT SHIPPED

Three closures, one product-direction shift.

Closure 1: Background-check subsystem audit (deferred S56). Full hybrid build — GAM owns the intake (form, SSN/DOB/address/employment, ID images, intake-fraud risk score, application pool, match flow) and a regulated third-party CRA owns the credit/criminal screening. Migration 20260430204722_background_check_subsystem.sql adds ~36 cols to background_checks, drops 2 vestigial cols (applicant_name, applicant_email), creates 3 new tables (application_pool, pool_match_requests, tenant_notifications), widens 4 status CHECKs to include 'expired', adds tenants.background_check_id + tenants.background_check_status with their own CHECK, and adds a deferred FK at the bottom (background_checks.pool_entry_id → application_pool.id). 6-month freshness window: expires_at set on transition to complete or approved. Daily expiry processor in jobs/scheduler.ts:242 cascades bgc.status → tenants.background_check_status → application_pool.status → pool_match_requests.status (only pending/interested matches expire; report_purchased and not_interested are terminal). Cron at 0 3 * * *.

Closure 2: AZ-policy rip-pass. Migration 20260430213000_strip_az_defaults_and_rename_azroc.sql drops properties.state DEFAULT 'AZ', renames contractors.azroc_license → contractor_license_number (nullable), adds contractors.contractor_license_state. 14 anchor-counted patches across 10 files: shared package (Contractor.azrocLicense → contractorLicenseNumber/contractorLicenseState, UtilityBill.adminFee comment), API routes (properties Zod default, notifications footer), 10 frontend files (RegisterPage, PropertiesPage, OnboardingPage, UnitDetailPage, landlord+pos POSPage, BackgroundCheckPage). Kept where AZ is HQ-justified or factually correct: lib/timezone.ts STATE_TZ map + 'America/Phoenix' fallback (HQ default), lib/format.ts 50-state map (data not policy), property-intelligence portal (factually correct — AZ is the data, not legal-logic), seed.ts demo properties, scheduler.ts Phoenix-local comment (HQ), invoiceGeneration.ts COALESCE 'America/Phoenix' (HQ).

Closure 3: Acks file philosophy reset. Was 99 lines (pre-S59 had 137; S59 first stripped the closed S56 block down to 99). Now 19 lines — header explaining the new philosophy plus one legitimate harness-limitation ack (A:src/routes/esign.ts:430). Every phantom table or column previously suppressed is now build-debt visible to the harness on every run. Harness now reports 27 missing tables + 28 missing columns across 6 tables, exit code 1. That's the launch checklist. When the screaming stops, the launch list is done.

Product-direction shift on background checks: provider selected = Checkr Trust (their purpose-built tenant screening product, separate from the employment line). Covers criminal/felonies/evictions/civil judgments + income verification via direct payroll integrations + bank-account analysis + fraud signals + Fair Housing/FCRA compliance. White-label model: "GAM Background Check" in product UI, CRA name surfaces only in adverse action notice (legally required per FCRA §615). Pricing TBD — public retail is $30-80 base + 30-60% passthrough fees, but partner-program wholesale is materially lower and not published. Real number requires applying to Checkr Partner program. Deferred for next session.

Architecture decision documented: SSN to be stripped from GAM intake on next session. Checkr's hosted apply flow collects PII directly from the applicant on their FCRA-compliant infrastructure. GAM never holds full SSN. Eliminates ENCRYPTION_KEY logic, eliminates ssn_encrypted persist-then-delete window. Schema's applicant_redirect_url field is exactly the shape Checkr's hosted flow uses.

Pool product semantics, locked: approval = housed (off the market, removes pool entry if any → 'inactive'). Denial = candidate for pool (if consent_pool + risk_level != 'very_high'). Speculative applications (no landlordId at submit) skip the decision step and route straight to pool on provider 'complete'. Pool unlock = $1 per landlord (was $5 — emailPoolTenantInterested copy updated). Tenant pays at intake, single atomic payment. Landlord-pays-for-targeted-checks model is gone — landlords.bg_check_fee + bg_check_fee_min are now vestigial columns to drop.

Other new code shipped: services/backgroundProvider.ts (provider abstraction interface + MockProvider with HMAC-verifiable webhook + getProvider factory + listProviderNames + status mapper). riskScore.ts stripped of idVerification param + ID-block (123 → 109 lines). RiskResult.level retyped from string union to BackgroundRiskLevel from @gam/shared. shared/src/index.ts gained 5 new const exports + 5 types + 5 runtime guards (BACKGROUND_CHECK_STATUSES, TENANT_BACKGROUND_CHECK_STATUSES, APPLICATION_POOL_STATUSES, POOL_MATCH_STATUSES, BACKGROUND_RISK_LEVELS).

Backups on disk for one-line revert: apps/api/src/routes/background.ts.s58backup (~32K), apps/api/src/services/email.ts.s59backup, apps/api/scripts/diff-schema.acks.s59backup (the S56-block-only rewrite), apps/api/scripts/diff-schema.acks.s59rippass-backup (the full pre-rip 99-line version), and .s59-rippass-backups/ holding 10 frontend + backend files touched in the AZ rip-pass.

ACK FILE TRACKING

The acks file went from 137 lines → 99 lines (S56 block stripped during background-check closure) → 19 lines (philosophy reset, all build-debt acks ripped). Final state: header + one A: line for the legitimate esign.ts:430 false positive. Harness suppression count dropped from "27 tables, 28 columns, 1 anti-pattern" to "0 tables, 0 columns, 1 anti-pattern."

Note worth flagging: harness output still reports the suppression line counts when run, but those numbers describe acks-file lines, not acks-applied. We considered fixing the harness to distinguish "ack file declares" vs "ack file actively suppressing" — added to deferred. Low priority because the file is now down to one line, so the discrepancy is moot.

NEW STANDING RULES

S59-1: When the user uses abstract or directional language ("do it the right way," "this needs to be removed," "we always build for scale"), pause before assuming the smaller concrete reading. The bigger reading is usually a design or principle statement. If uncertain, ask what they mean before optimizing for mechanism. Cost this session: one full message of writing wrong heredoc plumbing when the user was talking about design choice on schema split. Pattern: jumping to mechanism when user is talking about principle.

S59-2: Acks file is reserved for legitimate harness limitations only (the A: anti-pattern false positives). Phantom tables and columns are build commitments — they live in the deferred list, not suppressed in acks. The harness is intentionally loud. When it reports zero drift, the launch checklist is done.

S59-3: Don't build infrastructure to track build infrastructure. The harness output IS the checklist. No tier YAML files, no parser flags, no metadata layer to filter "launch vs stage-2 vs post-capital." User reads harness output, decides what to build next, builds it. Considered building a launch-checklist.yaml + harness filter feature mid-session — user shut it down correctly. Standing instruction now: don't propose tracking systems for tracking systems.

S59-4: Vendor pricing speculation is a recon failure mode. Public retail prices are not what platforms actually pay through partner programs, and extrapolating upward from retail is the wrong direction — partner pricing exists to undercut retail. When user asks for vendor pricing, say "real numbers require applying to the partner program" rather than stacking estimated passthroughs on listed prices and presenting as "actual cost." Cost this session: one full message of $75-95 applicant fee math built on retail-rate estimates that are not what GAM would actually pay.

S59-5: Frontend code lives at apps/{tenant,landlord,admin,books,pos,marketing,listings,property-intel,property-api,admin-ops,api}/src — not the longer apps/{landlord-portal,tenant-portal,admin-portal,marketing-site,gam-books,property-intelligence,pos-app}/src paths I assumed in early recon. The shorter paths are correct.

DEFERRED — pick foundation-first

(All build commitments tracked here, not in acks. Harness exits non-zero with these visible until they're built. Three rough categories follow but they're descriptive, not enforced — treat as a flat list and pick what's blocking next.)

Closed in S59:
- Background-check subsystem audit
- AZ-policy strip (excluding Books, which is its own session)
- Acks file philosophy reset

Carried forward, harness-visible, build-shaped:

Background-check pre-launch follow-up: apply to Checkr Partner program (no commitment, ~2-week response, gates real pricing). Apply to 1-2 alternates for comparison (TazWorks wholesale, RentPrep enterprise, Findigs). Once Checkr is approved, run the SSN-strip refactor — the route currently still encrypts SSN inline. Checkr's hosted apply flow makes SSN-collection their problem. Backend route revision is small (drop ssn_encrypted writes, lean on applicant_redirect_url, refactor the dev-mock-webhook to skip the SSN block). Webhook raw-body wiring in index.ts also needed before real provider HMAC works (the global JSON parser strips the raw form Checkr's signature requires). Backend reconciliation of applicantPaymentIntentId waits on Stripe-wiring session.

Adverse action notice infrastructure: FCRA-compliant denial flow when a landlord denies a tenant. Must include CRA name, address, phone, summary of consumer rights, opportunity to dispute. Currently zero infrastructure for this — landlord PATCH /:id/decision flips status to denied and emails the tenant a generic notice via emailBackgroundDecision. Real adverse action notice is a regulatory requirement, not a feature. Build session.

Books generic state-tax rebuild: this absorbs everything Books-related from the AZ rip-pass plus the previously-known broken endpoints. Phantom employees table (route writes to non-existent table — books.ts:193). Rename az_withholding_pct → state_withholding_pct on books_employees. Rename azWithholdingPct → stateWithholdingPct on the frontend. Strip AZ-prefix UI labels in apps/books/src/main.tsx (8 sites). Strip hardcoded AZ A1-QRT/AZ A1-R from Tax Center deadlines list. Strip AZ flat-rate comment in calcTaxes. Build configurable per-state rate field + state-forms table + UI for landlords to enter their own rate. Plus the 5 broken bookkeeper endpoints. Plus genericize-vs-scope-lock decision now resolved as "build for every state."

Marketing site AZ copy review: apps/marketing/src/index.html says "Built for Arizona landlords. Expanding nationally," "AZ-compliant lease templates," "AZ-compliant calculations," with three Phoenix/Tucson/Mesa testimonials. Product positioning, not engineering — needs Nic in the loop on copy direction. Separate pass.

Maintenance subsystem build: routes/maintenance-portal.ts references nonexistent shifts, daily_tasks, parts_inventory, purchase_requests, scheduled_maintenance.

Work-trade subsystem build: routes/workTrade.ts references nonexistent work_trade_agreements, work_trade_logs, work_trade_periods. Confirmed S57 as build, not rip.

Notifications schema rebuild: phantom notification_preferences table + 7 phantom columns on notifications (data, email_sent, email_sent_at, landlord_id, read_at, sms_sent, sms_sent_at). Plus dead notification types (lease_expiring_60, lease_expiring_30, lease_renewal_survey from pre-S18 scheduler) still in NotificationBell + tenant prefs.

Team UI rebuild: phantom team_property_access table + 2 phantom columns on team_members (invite_email, invite_token). Single team_member_scopes table model.

Admin audit log subsystem: admin.ts:227 explicit "table may not exist yet, non-blocking" marker. Phantom admin_action_log. Build the audit table + write paths + admin UI to view it.

Utility billing subsystem build: phantom utility_bills table referenced by routes/utility.ts. Five real utility_meter* tables exist as scaffolding. Tenant portal already calls /utility/bills. Build needs schema + generation cadence + tenant display + allocation methods (RUBS, sub-metered, flat) + landlord-configurable admin fee with no platform legal advice on caps.

Master Schedule finish-or-strip: 8 phantom columns on units + 1 phantom column on unit_bookings (8 already known: max_stay_nights, min_stay_nights, monthly_rate on units; landlord_id, lease_type, nightly_rate, platform_fee, source, weekly_rate on unit_bookings). SchedulePage.tsx references all 8. unit_bookings table exists but no booking flow UI. Now confirmed launch tier per S59 conversation.

ReportsPage endpoint build: ReportsPage.tsx calls GET /api/reports/summary which does not exist. Page renders empty dashes. Endpoint design (collected MTD, outstanding balance, occupancy, monthly rollup, PM vs landlord splits) + build.

Properties endpoint audit: PATCH /api/properties/:id has $9 placeholder bug (used twice) + amenities column referenced but doesn't exist. Full properties audit session.

PM subsystem build: pm.ts references phantom pm_companies, pm_fee_plans tables and phantom landlords.pm_company_id, pm_fee_plan_id. Confirmed S58 as build, not rip. pm.ts.s20backup preserved for reference.

POS app completion: 13 phantom pos_* tables. Standalone product per S59 conversation, build for launch but lower priority within tier.

E-sign frontend: backend done in S58. ConfirmIntentModal entity arrays shipped S29c-2-F. Visual + e2e smoke deferred to backend-complete consolidation per UI/UX standing rule. Plus deferred items previously bundled with e-sign: witness-in-send-modal, tenant draft persistence, tenant decline-with-reason path, tenant view-only re-open of executed/in-flight docs, movie-font signature → professional fonts, initials lock-to-name (low priority).

Stripe real wiring: confirmed launch tier in S59 because GAM needs to bring in money. Multiple flows wait on this: applicant payment for background check, OTP enablement infrastructure, pool unlock $1, real Stripe replacing the pi_intake_/pi_pool_ mock IDs throughout, and the 5 broken bookkeeper endpoints intersect this.

Permission gating audit across landlord portal: every screen + route needs role+scope filtering. /api/background/fee/:landlordId currently unauth (low risk — UUIDs are hard to guess but flagged).

S23d Tier 1 CHECK migrations: 11 of 14 still pending the next infra session.

Two parallel email systems consolidation: services/email.ts (Resend) vs lib/email.ts (nodemailer). Single system, single sender. Has known npm audit blockers.

landlords.bg_check_fee + landlords.bg_check_fee_min vestigial column drop. Landlord doesn't pay for targeted bg check anymore. Tiny migration.

Stage-2 (post-launch invite-pattern rollout): Flex Suite reintroduction (post-capital, post-legal review — phantom flex_charge_accounts, flex_charge_transactions, 6 phantom cols on tenants). OTP enablement (3 phantom cols on disbursements, 1 on tenants — otpScheduler.ts:65 INSERT references columns not on disbursements; will throw at runtime if scheduler ever fires; currently disabled).

Post-capital / post-team: in-house background-check + tenant-pool + risk-scoring product (after launch + capital + legal review — distinct from current Checkr-based hybrid). Sublease subsystem full build. Cross-platform audit trail validation. Tenant-pool endpoint refinements.

Smaller tracked items: short-term booking acknowledgment docs on unit_bookings. Payment-method surcharge passthrough at property level. Consolidated landlord-side ACH pull optimization. Guarantor/cosigner billing flow. Property late-fee edit confirmation modal (with addendum/notice-period reminder). Lease-change addendum workflow with legal notice timing. Deposit interest accrual engine. Landlord disbursement engine that nets tenant-owed deposit interest from monthly payouts. leases.security_deposit deprecation into lease_fees. S26a catch-up window admin endpoint (POST /admin/invoices/backfill, date range + dry-run). lease_fees.due_timing='move_out' and 'other' not consumed by any generator yet. Email-failure surface to landlord UI. Punch-list-resubmit limbo dispatch. ConfirmIntentModal noUnusedLocals strict-mode hygiene pass on landlord (~20 hits). End-to-end /resolve smoke including landlord-overridden entity rows. Platform-specific CSV import mappings (Buildium, AppFolio, DoorLoop, Yardi, RentManager, Propertyware, Rentec Direct, TenantCloud + 1-2 TBD). Tenant-pool picker + unit picker with consent rule. 5 of 8 npm audit vulnerabilities (nodemailer pending email consolidation; uuid via node-cron + svix + resend pending major-version session).

Harness extension: scan SELECT references too. Currently INSERT/UPDATE only. SELECT-only drift on phantom tables won't surface. Lower priority. Plus new sub-item: distinguish acks-file-listed vs acks-applied in the suppression count output. Trivially low priority since the file is now one line.

NUMBERING

S59 was the 59th chat with Claude on this codebase. Session count = chat count. Next is S60. Clean increment. No letters, no sub-prefixes.

End of S59 handoff.
