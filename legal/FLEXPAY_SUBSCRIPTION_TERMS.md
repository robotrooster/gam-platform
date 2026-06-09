# FlexPay Subscription Terms

**Gold Asset Management**
2843 East Frontage Road, Amado, AZ 85645
Template Version: 1.0
[Effective Date populated by the Platform at enrollment]

---

> **WHAT THIS IS.** These FlexPay Subscription Terms govern
> your enrollment in **FlexPay**, a Platform feature offered
> by Gold Asset Management LLC ("**GAM**") that lets you
> customize the scheduling of the rent and recurring-charge
> payments you authorize through the Platform.
>
> **FlexPay is a subscription product. It is not a loan or
> extension of credit.** GAM does not advance any funds on
> your behalf when you enroll in FlexPay. The substantive
> characterization, fee handling, and dispute-resolution
> framework are set out in Section 9.2 of GAM's Consumer
> Terms of Service (the "**Consumer ToS**"), which is
> incorporated into these Subscription Terms by reference.
> Capitalized terms used here without definition have the
> meaning given in the Consumer ToS.

---

## 1. Parties and Effective Date

These Subscription Terms are between:

- **GAM**: Gold Asset Management LLC, a Delaware limited liability company.
- **Subscriber**: {{Tenant_Full_Legal_Name}}, the individual identified by the GAM Platform account at {{Tenant_Email}}.

The Effective Date is the date Subscriber electronically signs at the FlexPay enrollment surface. By electronically signing, Subscriber agrees to these Subscription Terms, acknowledges the auto-renewal disclosure in Section 6 below, and authorizes the ACH-pull for the monthly subscription fee.

## 2. Service Description

FlexPay is a **payment-date coordination subscription**. Subscriber may use FlexPay to:

- Select a custom date in each calendar month for the ACH pull of rent (a "**Scheduled Pull Date**") that differs from the Subscriber's default rent due date;
- Split the monthly rent pull into two pulls within the calendar month, on dates Subscriber selects;
- Align Scheduled Pull Dates with Subscriber's stated payday or income arrival pattern;
- Configure additional scheduling features that GAM may add to FlexPay from time to time, disclosed at the enrollment surface.

The monthly subscription fee depends on the Scheduled Pull Date Subscriber selects under Section 3.

**FlexPay is a scheduling tool only.** It does not change the amount of rent or other charges Subscriber owes. It does not advance any amount on Subscriber's behalf. It does not guarantee that any Scheduled Pull will succeed; if the funds in Subscriber's authorized bank account are insufficient on the Scheduled Pull Date, the pull will fail and Subscriber's account will reflect the unpaid rent (or other unpaid amount) until brought current.

**FlexPay does not modify any Landlord remedy** that the Landlord may have for unpaid or late rent under the lease, including without limitation late fees, default notices, or eviction proceedings. Subscriber selecting a later Scheduled Pull Date that falls after Subscriber's rent due date does not waive the Landlord's right to a late-fee accrual or other lease remedy based on the rent due date. The Landlord may, but is not required to, accept the FlexPay-scheduled date as the operative payment date for lease-remedy purposes.

## 3. Monthly Subscription Fee — Date-Based Formula

The FlexPay monthly subscription fee is calculated as a function of the calendar day of the month on which Subscriber's Scheduled Pull Date falls.

**Formula:** Monthly Fee = **$5.00 + ($1.00 × Scheduled Pull Date)**, where the Scheduled Pull Date is a calendar day from the 1st through the 28th of the month.

Worked examples:

| Scheduled Pull Date | Monthly Fee |
|---|---|
| 1st | $6.00 |
| 5th | $10.00 |
| 11th | $16.00 |
| 15th | $20.00 |
| 20th | $25.00 |
| 28th (latest available) | $33.00 |

Subscriber's selected Scheduled Pull Date and the corresponding Monthly Fee at enrollment:

- **Scheduled Pull Date:** the {{Scheduled_Pull_Day}} of each calendar month
- **Monthly Fee:** **${{Selected_Monthly_Fee}}**

The Scheduled Pull Date is capped at the 28th calendar day of the month. The 29th, 30th, and 31st are not available because not every month contains those days, which would create an inconsistent pull schedule.

**Changing the Scheduled Pull Date.** Subscriber may change the Scheduled Pull Date at any time through the in-platform FlexPay settings. The change takes effect on the next full billing cycle; the new Monthly Fee for the new Scheduled Pull Date applies from that cycle forward.

**GAM reserves the right to revise the pricing formula prospectively** with thirty (30) days' notice by email and in-platform notification. Subscriber's continued use of FlexPay after the effective date of a pricing change constitutes acceptance of the revised pricing; if Subscriber does not agree to the revised pricing, Subscriber may cancel under Section 7 before the effective date.

## 4. Subscription Fee Authorization

Subscriber authorizes GAM, acting through Stripe, Inc., to initiate ACH debits from Subscriber's authorized bank account for the FlexPay monthly subscription fee at the cadence disclosed at enrollment (currently: monthly, on the Scheduled Pull Date alongside the rent pull).

**Authorized Account:**
- Bank: {{Bank_Name}}
- Account ending in: {{Account_Last_4}}

### 4.1 Failed ACH Pull — Retry on a Later Day at a Recalculated Amount

If a scheduled ACH pull under this FlexPay subscription (the rent pull on Subscriber's Scheduled Pull Date, or the separate FlexPay subscription-fee pull if pulled separately) fails for a recoverable cause — including without limitation insufficient funds, account closed, account frozen, ODFI/RDFI rejection, or other Nacha return code — the Platform will automatically retry the pull on a later calendar date under GAM's standard failed-pull retry policy (typical cadence: one retry approximately three business days after the failure, and a second retry approximately five business days after the first retry if needed).

**The retry pull is for a recalculated amount, not the original amount.** Because FlexPay's Monthly Fee is calculated under the date-based formula in Section 3 — Monthly Fee = $5 + ($1 × actual pull date) — the FlexPay Monthly Fee for the billing cycle is **recalculated** to reflect the calendar day on which the retry pull is initiated. The retry pulls:

- **(a)** The rent amount (which does not change);
- **(b)** The **recalculated FlexPay Monthly Fee** for the cycle, equal to $5 + ($1 × the calendar day of the retry pull), in lieu of the originally-scheduled FlexPay Monthly Fee; and
- **(c)** The Stripe pass-through fees described in Section 4.2 below.

Worked example: Subscriber's Scheduled Pull Date is the 11th, producing an originally-scheduled FlexPay Monthly Fee of $16. The pull on the 11th fails for insufficient funds. The Platform retries on the 15th. The retry pulls the rent amount + a recalculated FlexPay Monthly Fee of $20 ($5 + $15) + the applicable Stripe pass-through fee. If the retry on the 15th also fails, a second retry on the 22nd would recalculate to $5 + $22 = $27.

The recalculated FlexPay Monthly Fee for the cycle is the fee applicable to that cycle, replacing the originally-scheduled amount in full; **Subscriber's prior payment of the originally-scheduled fee (if any was already collected) is credited toward the recalculated fee**, and only the incremental difference is added to the retry pull.

If all retry attempts under GAM's failed-pull retry policy fail, the recalculated (last-retry-day) Monthly Fee and the Stripe pass-through fees are added to Subscriber's GAM-platform-side balance and subject to the GAM-First payment-routing rules in Consumer ToS § 5.5.

### 4.2 Stripe Pass-Through Fees

When an ACH pull under this FlexPay subscription fails, is returned, is reversed, or is disputed, Stripe charges GAM a per-event fee. **Subscriber pre-authorizes the pass-through of those Stripe-charged fees to Subscriber, at GAM's actual cost, without markup by GAM.**

The pass-through fee is added to the retry pull under Section 4.1(c) above, or to the next subsequent ACH or card payment Subscriber authorizes through the Platform if no retry succeeds, under the GAM-First payment-routing rules in Consumer ToS § 5.5.

Pass-through fees are **not** GAM service fees and are **not** a finance charge under Regulation Z. They are the actual cost of payment processing that GAM incurred and that Subscriber pre-authorizes to bear because the event causing the fee was attributable to Subscriber's payment activity. Stripe's current ACH-return / dispute / failure fee schedule is published at https://stripe.com/pricing and may be revised by Stripe from time to time; the schedule in effect on the date of each failure event governs that event's pass-through amount.

### 4.3 Separation of Authorizations

This subscription-fee ACH authorization is **separate** from any ACH authorization Subscriber has provided for FlexDeposit installments or any other purpose. Revoking another ACH authorization does not revoke this FlexPay subscription-fee ACH authorization, and vice versa.

## 5. GAM-First Payment Routing

Subscriber acknowledges and authorizes the GAM-first payment routing described in Consumer ToS § 5.5 as it applies to FlexPay subscription fees. Specifically, any unpaid FlexPay subscription fee is a GAM-side balance that the Platform applies first to any ACH or card payment Subscriber subsequently authorizes through the Platform, on a first-in, first-out basis, before settling any remainder to Subscriber's Landlord's Connect balance.

GAM is not liable for any rent shortfall on Subscriber's Landlord-side ledger that results from a FlexPay subscription fee being prioritized under this Section 5. Subscriber remains responsible to Subscriber's Landlord for the rent owed.

## 6. Auto-Renewal Disclosure (Clear and Conspicuous)

> **FLEXPAY AUTOMATICALLY RENEWS EACH MONTH. UNLESS SUBSCRIBER
> CANCELS UNDER SECTION 7 BEFORE THE END OF THE CURRENT BILLING
> CYCLE, GAM WILL CHARGE THE THEN-APPLICABLE FLEXPAY MONTHLY
> FEE TO SUBSCRIBER'S AUTHORIZED ACCOUNT FOR EACH SUCCESSIVE
> MONTH. SUBSCRIBER MAY CANCEL AT ANY TIME THROUGH THE
> IN-PLATFORM CANCELLATION SURFACE; CANCELLATION TAKES EFFECT
> AT THE END OF THE THEN-CURRENT BILLING CYCLE.**

This disclosure is provided in compliance with each of the following state automatic-renewal statutes:

- **California**: Business and Professions Code § 17600 et seq. (Automatic Renewal Law).
- **New York**: General Business Law § 527-a.
- **Massachusetts**: G.L. c. 93, § 113.
- **Oregon**: ORS 646A.295.
- **New Jersey**: N.J.S.A. 56:12-14.1.

By signing these Subscription Terms below, Subscriber **affirmatively consents** to the FlexPay auto-renewal terms set out above, including the monthly fee, the auto-renewal cadence, and the cancellation method described in Section 7. Subscriber acknowledges that the auto-renewal terms were presented in a clear and conspicuous manner before Subscriber consented.

**Acknowledgment of receipt.** A copy of these Subscription Terms (including the auto-renewal disclosure in this Section 6) is delivered to Subscriber by email to the address on file immediately after enrollment, in compliance with the acknowledgment-of-receipt requirements of California Bus. & Prof. Code § 17602(a)(3) and the analogous state provisions.

## 7. Cancellation

Subscriber may cancel FlexPay at any time through any of the following methods:

- **In-Platform Cancellation Surface (Primary).** Navigate to Account Settings → FlexPay → Cancel Subscription. The cancellation is processed immediately upon Subscriber's confirmation; no additional steps are required.
- **Email.** Send a cancellation request to `support@goldassetmanagement.com` with "FlexPay Cancel" in the subject line. GAM will process the cancellation within two (2) business days of receipt.
- **Phone or Mail.** Where required by state law (e.g., California Bus. & Prof. Code § 17602(c) for online-signup cancellation parity), Subscriber may cancel by phone at {{Support_Phone_Number}} or by mail at the address in the contact block below.

**Effect of cancellation.** Cancellation stops the FlexPay subscription at the end of the then-current billing cycle. Subscriber retains the chosen Scheduled Pull Date through the end of that billing cycle; the rent due date reverts to the Platform default (the date specified in Subscriber's lease) after cancellation takes effect. **Subscription fees already paid for the then-current billing cycle are non-refundable** under Section 10 of the Consumer ToS, except where state law requires a pro-rated refund (see Section 8 below).

Cancellation of FlexPay does not affect any other Platform feature, including any other FlexSuite enrollment, rent payment authorizations, or any FlexDeposit Service-Level Agreement Subscriber has in place. Each is governed by its own terms.

## 8. Refunds

Subscription fees paid for the then-current billing cycle are **non-refundable** as a default rule, consistent with Consumer ToS § 10.

**State-specific override.** Where the law of Subscriber's state of residence requires a pro-rated refund of subscription fees on cancellation, GAM will refund the pro-rated portion of the then-current billing cycle's fee at the time cancellation takes effect. This applies, among others, to subscribers in California (where the Automatic Renewal Law and CLRA may require pro-rated refund in certain circumstances) and New Jersey (where TCCWNA may reach a non-pro-rated rule as a "clearly established legal right" of the consumer).

To request a state-specific pro-rated refund, contact `support@goldassetmanagement.com` with "FlexPay Refund Request" in the subject line and Subscriber's state of residence; GAM will evaluate the request against the applicable state law and respond within thirty (30) days.

## 9. No Credit Extension; No Debt

The parties expressly agree and intend that these Subscription Terms create a subscription-services relationship only. **FlexPay is not, and shall not be construed as, a loan, an extension of consumer credit, a "credit transaction" under the Truth in Lending Act or Regulation Z, an extension of credit under the Equal Credit Opportunity Act or Regulation B, a consumer financial product or service under the Consumer Financial Protection Act, a debt under the Fair Debt Collection Practices Act, or a "loan" or "extension of credit" under any state consumer-finance, consumer-installment-loan, small-loan, or usury statute.**

GAM does not advance any funds on Subscriber's behalf under FlexPay. The monthly subscription fee is consideration for the scheduling-service access only.

If a FlexPay subscription fee is unpaid, GAM's sole and exclusive remedies are:

- **(a)** Application of the unpaid fee to any subsequent ACH or card payment Subscriber authorizes through the Platform, per the GAM-first routing in Section 5;
- **(b)** Suspension of Subscriber's FlexPay scheduling features (reverting to Platform-default rent due date) until the unpaid fee is satisfied;
- **(c)** Cancellation of the FlexPay subscription by GAM under Section 11.2 below.

GAM will not sue Subscriber for unpaid FlexPay subscription fees, engage a collections agency to recover them, or furnish unpaid FlexPay data to any consumer reporting agency.

## 10. Term and Renewal

These Subscription Terms take effect on the Effective Date and automatically renew each month under Section 6 unless cancelled under Section 7 or terminated under Section 11.

## 11. Termination

### 11.1 Termination by Subscriber

See Section 7 (Cancellation).

### 11.2 Termination by GAM

GAM may terminate the FlexPay subscription, with or without notice, for: (a) repeated failed ACH pulls on the monthly subscription fee; (b) Subscriber's commencement of any bankruptcy or insolvency proceeding; (c) Subscriber's closure of the GAM Platform account; (d) any event described in Consumer ToS § 18.2 (Termination by GAM under the Consumer ToS); or (e) GAM's discontinuation of the FlexPay product (with at least thirty (30) days' notice to Subscriber and pro-rated refund of any prepaid period).

## 12. Incorporation of Consumer Terms of Service

The Consumer ToS, including without limitation Section 5 (Payment Processing), Section 9.2 (FlexPay), Section 9.5 (Auto-Renewal Disclosures), Section 10 (Refunds), Section 16 (Limitation of Liability), Section 17 (Indemnification), Section 19 (Dispute Resolution; Binding Arbitration; Class Action Waiver), and Section 20 (Governing Law and Venue), is incorporated into these Subscription Terms by reference. **In the event of a conflict between these Subscription Terms and the Consumer ToS, these Subscription Terms prevail for matters expressly addressed here, and the Consumer ToS prevails for all other matters.**

Any dispute arising out of or relating to these Subscription Terms is subject to the binding-arbitration, class-action-waiver, and public-injunctive carve-out provisions of Consumer ToS § 19, including the thirty-day opt-out window provided in § 19.6.

## 13. Electronic Signature

By clicking [I AGREE] or by otherwise indicating affirmative assent at the Platform's electronic-signature surface, Subscriber electronically signs these Subscription Terms in accordance with the federal Electronic Signatures in Global and National Commerce Act (15 U.S.C. § 7001 et seq.) and applicable state Uniform Electronic Transactions Acts. Subscriber's electronic signature is the legal equivalent of a handwritten signature. The Platform's audit trail records Subscriber's IP address, user-agent, and timestamp of signature.

---

## Affirmative Consent

By electronically signing below, Subscriber **affirmatively consents** to:

- These Subscription Terms in their entirety, including the express no-credit-extension paragraph in Section 9;
- The Scheduled Pull Date selection in Section 3 and the corresponding monthly fee under the date-based pricing formula;
- The ACH-pull authorization in Section 4 for the monthly subscription fee;
- The auto-renewal of the FlexPay subscription as described in Section 6;
- The GAM-first payment-routing acknowledgment in Section 5;
- The incorporation of the Consumer ToS by reference in Section 12.

| | |
|---|---|
| **Subscriber electronic signature:** | {{Tenant_Signature}} |
| **Subscriber printed name:** | {{Tenant_Full_Legal_Name}} |
| **Scheduled Pull Date:** | the {{Scheduled_Pull_Day}} of each calendar month |
| **Monthly fee (per § 3 formula):** | ${{Selected_Monthly_Fee}} |
| **Effective Date:** | {{Signature_Date}} |
| **IP address at signature:** | {{Tenant_IP_Address}} |
| **User-agent at signature:** | {{Tenant_User_Agent}} |

**Countersigned by GAM:**

| | |
|---|---|
| **Authorized signer:** | Gold Asset Management LLC, by its automated enrollment system |
| **Date of countersignature:** | {{Signature_Date}} |

---

## Contact

Questions about these Subscription Terms? Email `support@goldassetmanagement.com` or write to:

Gold Asset Management LLC
Attn: FlexPay Subscription Terms
2843 East Frontage Road
Amado, AZ 85645
