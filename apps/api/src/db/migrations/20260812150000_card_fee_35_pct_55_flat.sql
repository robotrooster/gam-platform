-- Card fee → 3.5% + $0.55 (S603, Nic; supersedes the S552 3.25% + $0.26 schedule).
--
-- WHY: the first live-fire card charge (S600, $2.33) exposed that GAM's card fee
-- was structurally under-recovering. Stripe bills GAM on an UNBUNDLED IC+ contract
-- where the real per-transaction cost is four components, two of them charged per
-- AUTHORIZATION rather than per payment:
--
--     interchange (posts as `network_cost`)   — varies by card type
--   + Stripe volume fee                        0.70%
--   + Stripe per-authorization fee             $0.26   ← per auth, incl. declines
--   + Radar                                    $0.02   ← per auth, incl. declines
--
-- The old $0.26 customer-facing flat recovered exactly ONE Stripe auth fee and
-- nothing else — not Radar, not interchange's own fixed leg ($0.10 credit / $0.21
-- regulated debit), and not the wasted authorizations (card-save verifications and
-- declines) that earn no revenue at all. True fixed cost per SUCCESSFUL payment is
-- ~$0.55 once a share of wasted auths is amortized in. Hence $0.26 → $0.55.
--
-- On the percentage: 3.25% left only 2.55% for interchange after Stripe's 0.70%,
-- which every commercial/corporate card (~2.70-3.15%) exceeded — those lost money,
-- and the loss GREW with the payment amount. 3.50% leaves 2.80%, which clears
-- consumer debit and credit (incl. premium ~2.40%) with room, and narrows the
-- commercial case to a small loss that only begins above ~$113:
--
--     commercial card @ $300 booking  -$0.28   @ $650 rent  -$0.81   @ $1,200  -$1.63
--
-- Nic's call (S603): accept that edge. Commercial cards concentrate in short-term
-- bookings (a few hundred dollars), not $1,200 rents, so the exposure is small and
-- is covered by margin elsewhere. 3.75%/3.90% would erase it but read worse to every
-- ordinary tenant, who is the common case.
--
-- COST SIDE LEFT UNCHANGED (2.90% + $0.26) ON PURPOSE. The true blended cost depends
-- on the debit/credit mix, which GAM has no volume to measure yet. Holding the old
-- (higher) estimate keeps `banking_spread` CONSERVATIVE — it under-reports GAM
-- revenue rather than over-reporting it. Re-derive from real `network_cost` balance
-- transactions once there is volume. See SESSION_603_HANDOFF.md.
--
-- Mirrors PROCESSING_FEES in packages/shared/src/index.ts — the two MUST move
-- together. ACH is untouched (flat $6, negotiated 0.5%/$3.00 cost).
--
-- Append-only (keep-everything): expire the current card row, insert the new one;
-- allocation.fetchActiveProcessingRate reads effective_until IS NULL.

UPDATE platform_processing_rates
   SET effective_until = now()
 WHERE payment_method = 'card' AND effective_until IS NULL;

INSERT INTO platform_processing_rates
  (payment_method, customer_facing_flat, customer_facing_percent, customer_facing_cap,
   stripe_cost_flat, stripe_cost_percent, stripe_cost_cap, effective_from, notes)
VALUES
  ('card', 0.55, 3.5000, NULL, 0.2600, 2.9000, NULL, now(),
   'S603 (Nic): card 3.5% + $0.55/txn customer-facing. Flat raised from $0.26 to cover the REAL fixed cost (Stripe $0.26/auth + $0.02 Radar + interchange fixed leg + amortized wasted auths from card-saves and declines). Percent raised from 3.25% so consumer credit incl. premium clears; commercial cards accepted as a small known loss above ~$113. Cost side held at the old conservative 2.9%+$0.26 estimate until real volume allows a blended re-derivation.');
