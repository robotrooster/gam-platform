---
scope: landlord
title: Tenant payment fees and the pass-through toggle
---
Every electronic rent payment carries a small processing fee. GAM lets you decide, per property, whether your tenant or you cover it. GAM never absorbs the fee itself, so one side or the other always pays it.

Here are the standard processing rates:

- ACH (bank transfer): 1.0%, capped at $6 per payment
- Card: 3.25%
- Canadian cards paid in USD: an extra 1.5% on top

The per-property pass-through toggle controls who pays:

- Tenant pays: the fee is added on top of the rent at checkout, so the tenant sees the rent plus the processing fee. You receive the full rent amount.
- Landlord pays: the tenant pays exactly the rent, and the fee is netted out of what you receive.

Because the setting lives at the property level, you can run different properties differently. A good way to think about it: "tenant pays" keeps your payout clean and predictable, while "landlord pays" makes the tenant's total simpler at the cost of a deduction on your side.

This processing fee is completely separate from the monthly platform fee ($2 per occupied unit, $10 per-property minimum). One is per-payment, the other is monthly.

How payouts work alongside this: tenant payments are collected electronically, and once the funds clear, GAM sends your money to your connected bank through Stripe Connect on your payout schedule. You'll need to finish Stripe Connect onboarding (a quick identity and bank-verification step) before payouts can be sent.

Rent amount, due date, grace period, and any late fees are all set by you on each lease. The processing fee only applies to the electronic payment itself, not to how you structure the rent.
