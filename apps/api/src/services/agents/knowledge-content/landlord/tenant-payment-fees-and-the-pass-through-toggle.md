---
scope: landlord
title: Tenant payment fees and the pass-through toggle
---
Every electronic rent payment carries a small processing fee. GAM never absorbs it, so one side or the other always pays — and the rules are simple: **card fees are always paid by the tenant** (added on top at checkout — landlords never cover card), and for **ACH you choose per property** whether your tenant or you cover it.

Here are the standard processing rates:

- ACH (bank transfer): a flat $6 per payment
- Card: 3.25% plus $0.26 per transaction
- Non-US-issued cards: an extra 1.5% on top

The ACH pass-through choice works like this:

- Tenant pays: the fee is added on top of the rent at checkout, so the tenant sees the rent plus the processing fee. You receive the full rent amount.
- Landlord pays: the tenant pays exactly the rent, and the ACH fee is netted out of what you receive.

The choice lives at the property level, so you can run different properties differently. A good way to think about it: "tenant pays" keeps your payout clean and predictable, while "landlord pays" makes the tenant's total simpler at the cost of a deduction on your side. Your account-wide default is set at onboarding and new properties inherit it; you can override any property later.

This processing fee is completely separate from the monthly platform fee ($2 per occupied unit, $10 per-property minimum). One is per-payment, the other is monthly — and the platform fee has its own per-property payer setting (default: landlord).

How payouts work alongside this: tenant payments are collected electronically, and once the funds clear, GAM sends your money to your connected bank through Stripe Connect on your payout schedule. You'll need to finish Stripe Connect onboarding (a quick identity and bank-verification step) before payouts can be sent.

Rent amount and due date are set on each lease; late-fee terms come from your per-property, per-unit-type policy. The processing fee only applies to the electronic payment itself, not to how you structure the rent.
