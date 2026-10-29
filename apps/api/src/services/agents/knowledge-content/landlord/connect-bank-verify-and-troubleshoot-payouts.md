---
scope: landlord
title: Connecting your bank, verifying your identity, and fixing a missing payout
---
Before GAM can pay you, you need to connect a bank account. We use Stripe Connect to handle this securely, which means a short onboarding step where Stripe collects and verifies your details — this is the identity verification (KYC) that financial regulations require. You'll enter your legal/business information, link your bank account, and Stripe confirms everything in the background. Your sensitive banking details live with Stripe, not in GAM's records.

Until onboarding is fully complete and your identity is verified, payouts can't be sent — so it's worth finishing this step early. If Stripe needs another document or a correction, your account will show what's outstanding; clearing those items unblocks your payouts.

There is one place to do this: the **Bank** page, on its **Bank setup** tab. It has two steps for one bank account, in order. Step 1, **Get paid**: press **Connect account for payouts** and Stripe's verification opens right there; the routing and account number your rent goes to are entered inside that Stripe form, not anywhere else in GAM. Step 2, **Connect your bank**: link that same account read-only so your spending becomes expenses — a separate permission your bank grants, which is why it is its own step. Setup is not finished until both are done, and the page says so until they are. GAM used to also have its own bank list where you could type an account in by hand. That list never set up payouts and never sent anything to Stripe — so a bank typed in there gets no deposits and no verification. It has been removed; if you used it, finish Stripe's verification on the Bank setup tab instead. There is no longer a separate "Disbursement Account" page — it was folded into Bank setup, and its old address opens there. Every property pays out to the account its company verified with Stripe — there is no separate payout account to pick per property.

Expecting a payout that didn't arrive? Walk through these in order:

- Check that onboarding is complete. If verification is still pending or Stripe has flagged a missing detail, payouts pause until it's resolved.
- Confirm there's a cleared, available balance. Payouts only move funds that have finished settling — a payment made in the last day or two may still be clearing and not yet payable.
- Mind the schedule and timing. Payouts land on Tuesday and Friday from the 1st through the 10th, then on Tuesdays, plus once by the last business day of the month — shifting to the next business day around US federal holidays. Money only goes out once it has cleared: about two business days for a card payment and four for a bank payment.
- Verify your linked bank details. An outdated or closed account can cause a transfer to fail and return.

If everything above looks right and the payout still hasn't shown up after a couple of business days, reach out to support with the date and amount you expected and we'll trace it for you. For questions tied to deposits, withholding, or anything legal-adjacent, that depends on your lease and your local law — GAM handles the money movement, not legal advice.
