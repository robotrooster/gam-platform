# Consumer Terms of Service

**Gold Asset Management**
2843 East Frontage Road, Amado, AZ 85645
Effective Date: [DATE OF PUBLIC LAUNCH]
Last Updated: [DATE]

---

> **WHO THESE TERMS APPLY TO.** These Consumer Terms of Service
> govern your use of the GAM platform as a Tenant — an
> individual renting a unit from a Landlord whose property is
> listed on the Platform and paying rent through the Platform.
>
> If you are a Landlord, a property-management company, or a
> staff member operating under a Landlord or PM Company, these
> Consumer Terms do not apply to you. See the
> [Business Terms of Service](./BUSINESS_TERMS_OF_SERVICE.md)
> instead.

---

## 1. Agreement to These Terms

These Consumer Terms of Service (the "**Terms**") form a binding legal agreement between you and **Gold Asset Management LLC**, a Delaware limited liability company with its principal place of business at 2843 East Frontage Road, Amado, Arizona 85645 ("**GAM**," "**we**," "**us**," or "**our**").

By creating an account, accessing, or otherwise using the GAM platform as a Tenant — including the tenant portal, mobile-responsive surfaces, and related services we operate under the Gold Asset Management brand (collectively, the "**Platform**") — you agree to these Terms and to the [Consumer Privacy Policy](./CONSUMER_PRIVACY_POLICY.md), which is incorporated by reference. If you do not agree, you must not use the Platform.

You also agree to the additional service-specific terms presented within the Platform at the time you enroll in or use a specific feature (e.g., the FlexDeposit Service-Level Agreement, FlexPay subscription terms, FlexCharge Business Account Agreement, FlexCredit third-party lender disclosure, lease electronic-signature consent, and background-check authorization). Those service-specific terms are incorporated by reference and prevail to the extent they conflict with these Terms for the specific feature they govern.

## 2. Eligibility

You may only use the Platform as a Tenant if:

- You are at least 18 years of age;
- You have the legal capacity to enter into a binding contract under the law of your state of residence;
- You are not barred from using the Platform under United States law or the law of your jurisdiction; and
- You will use the Platform in compliance with all applicable laws.

## 3. Description of the Platform (Tenant Surfaces)

GAM is a real estate operations platform that connects you to your Landlord and to the services that support your tenancy. The Platform's tenant-facing features include:

- Account creation and identity verification
- Lease document access and electronic signature
- Rent and other charge payment via ACH (bank account) or card
- Maintenance ticket submission and tracking
- Inspection and entry-request communications
- Deposit handling, including GAM-escrowed deposit for new tenancies and the deposit-return statement at lease end
- Optional enrollment in FlexSuite tenant products (FlexDeposit, FlexPay, FlexCharge, FlexCredit) where eligibility criteria are met
- Notification preferences for the communications you receive from your Landlord and from GAM
- The ability to dispute charges, request payment-plan accommodations, and raise habitability concerns

GAM is **not** a real estate broker, mortgage lender, escrow agent in the regulated sense, attorney, accountant, tax advisor, or fiduciary. GAM is also **not** your Landlord. We provide software that supports your tenancy; your lease agreement is between you and your Landlord, and the obligations under that lease are governed by the lease and by the law of the property's state.

## 4. Account Registration and Security

To use the Platform you must register an account. You agree to:

- Provide accurate, current, and complete information during registration and keep it up to date;
- Maintain the security of your password and any other authentication credentials, including two-factor authentication where you enable it;
- Notify GAM promptly at `support@goldassetmanagement.com` if you suspect unauthorized access; and
- Take responsibility for activity that occurs under your account, except where unauthorized access has occurred despite your reasonable care and you have notified us promptly.

We may require additional verification (including identity verification through Stripe Identity, where applicable, or bank account verification through Plaid or Stripe Financial Connections) before enabling certain features, particularly the payment-method features.

## 5. Payment Processing

### 5.1 How Payments Work

GAM uses Stripe, Inc. ("**Stripe**") as its payment processor. When you pay rent, utility charges, late fees, or other charges through the Platform, the payment moves through Stripe Connect. By using the Platform's payment features, you also agree to Stripe's applicable terms of service.

GAM does not custody funds intended for your Landlord. Subject to Section 5.5 below (Payment Routing) and Section 5.6 (Unpaid Rent), each rent payment settles to your Landlord's Stripe Connect balance and is paid out to your Landlord per their Stripe payout schedule. GAM holds deposits in a separate pooled custody account, as described in Section 6.

### 5.2 Fees You May Pay

You pay the Platform's payment-processing fees on your payments by default, and the fee is disclosed at the checkout step before you confirm. Your Landlord may have elected at onboarding to cover your **ACH** processing fee — where your Landlord has done so, no ACH fee is shown to you. **Card processing fees are always paid by you and are never covered by your Landlord.** You can see whether a given charge carries a fee at the point you authorize payment.

When fees are passed through, the rates are:

- **ACH (bank account) payment processing**: 1.0% of the transaction amount, capped at $6.00 per transaction.
- **Card payment processing**: 3.25% of the transaction amount, flat (no cap). A 1.5% surcharge is added to charges paid with a non-United States–issued card, passed through to the cardholder.

If you enroll in FlexPay, the FlexPay enrollment terms disclose the monthly subscription fee (calculated per the date-based formula in Section 9.2 below); the fee is charged to you separately from your rent on the cadence disclosed at enrollment.

If you enroll in FlexDeposit, the FlexDeposit terms (Section 9.1) govern the installment schedule for funding your security deposit into GAM custody, plus the $3.00 monthly custody fee.

### 5.3 No Cash, No Check

The Platform supports electronic payments only (ACH and card). Cash, checks, money orders, and other paper instruments are not supported. Any in-person payment to your Landlord must be handled outside the Platform; your Platform account will continue to reflect the unpaid balance until the payment is recorded electronically.

### 5.4 Failed ACH Pulls, Retries, Chargebacks, and Pass-Through Fees

If you initiate a chargeback or your ACH payment is returned, the Platform will reflect the reversal and the resulting unpaid balance. Initiating a chargeback for a payment you have already received the benefit of (e.g., rent for a month you occupied the unit) may be treated as a breach of your lease and may be reported to your Landlord or, where applicable, to a consumer reporting agency.

**ACH is all-or-nothing.** Under the National Automated Clearing House Association (Nacha) rules that govern ACH transactions, a pull request either succeeds for the full amount requested or is rejected in full by your bank (typically with a return code such as R01 — insufficient funds, R09 — uncollected funds, or R02 — account closed). **Banks do not return a partial amount on an ACH pull.** If your account contains less than the requested amount on the scheduled pull date, the entire pull is rejected and no funds are collected.

**Automatic retry of failed ACH pulls.** If a scheduled ACH pull from your authorized bank account fails for a recoverable cause — including without limitation insufficient funds, account closed, account frozen, ODFI/RDFI rejection, or other Nacha return code — the Platform will automatically retry the pull on a later date under GAM's standard failed-pull retry policy. Typical retry cadence is one retry approximately three (3) business days after the initial failure and, if that retry also fails, a second retry approximately five (5) business days thereafter; the exact cadence is determined by GAM and may change without notice.

**Each retry pull attempts to collect:**

- **(a) The underlying amount then due under the applicable agreement.** For products priced on a date-based formula (e.g., FlexPay, governed by Section 9.2 and the FlexPay Subscription Terms), this amount is **recalculated based on the calendar day on which the retry pull is initiated** — see FlexPay Subscription Terms § 4.1 for the recalculation mechanics. For products with a fixed installment schedule (e.g., FlexDeposit SLA installments, governed by Section 9.1 and the FlexDeposit SLA), the underlying installment amount does not change — the retry attempts to collect the same installment amount as originally scheduled.
- **(b) Plus pass-through fees** (described below) applicable to **all** failed pulls under **all** products, regardless of whether the underlying amount is recalculated under (a) or remains fixed.

If all retry attempts under GAM's failed-pull retry policy fail, the unpaid balance (computed under the foregoing rules, inclusive of accumulated pass-through fees) is added to your GAM-platform-side balance and is subject to the GAM-First payment-routing rules in Section 5.5.

**Pass-through of payment-processing fees.** When an ACH pull, card payment, or other payment you authorize through the Platform fails, is returned, is reversed, or is disputed, the Platform's payment processor (Stripe, Inc.) charges GAM a per-event fee for the failure or return. **You pre-authorize the pass-through of those Stripe-charged fees to you, at GAM's actual cost, without markup by GAM.** The pass-through fee is added to your GAM-platform-side balance and applied first to the retry pull, or to the next subsequent ACH or card payment you authorize through the Platform, on a first-in, first-out basis, under the GAM-First payment-routing rules in Section 5.5.

Pass-through fees are **not** GAM service fees and are **not** a finance charge under Regulation Z. They are the actual cost of payment processing that GAM incurred and that you pre-authorize to bear because the event causing the fee was attributable to your payment activity through the Platform. Stripe's current ACH-return / dispute / failure fee schedule is published at https://stripe.com/pricing and may be revised by Stripe from time to time; the schedule in effect on the date of each failure event governs that event's pass-through amount.

### 5.5 Payment Routing (GAM-First Application)

**PLEASE READ THIS SECTION CAREFULLY. IT AFFECTS HOW YOUR PAYMENTS ARE APPLIED.**

When you authorize an ACH pull, card payment, or other electronic payment through the Platform — whether for rent, recurring charges, or any other amount you direct to your tenant account — **GAM applies that payment first to any outstanding balance you owe GAM** before settling any remainder to your Landlord's Stripe Connect balance. Outstanding balances owed to GAM may include, without limitation:

- FlexDeposit Service-Level Agreement installments (see Section 9.1) that are then due;
- FlexPay subscription fees (see Section 9.2) that are then due;
- Payment-processing fees that pass through to you under Section 5.2;
- Any other fee you have agreed to under these Terms or a service-specific agreement.

Within outstanding GAM balances, the Platform applies your payment on a **first-in, first-out basis** — the oldest unpaid GAM amount is satisfied first, then the next-oldest, and so on. After all outstanding GAM balances are satisfied from the authorized payment, the **remainder** (if any) settles to your Landlord's Stripe Connect balance and is credited toward your rent or other Landlord-owed amount.

By authorizing the payment, you authorize this routing. The Platform discloses the breakdown of how your payment was applied in your tenant portal after each payment settles, so you can see what went to GAM (and to which category), what went to your Landlord, and what remained unpaid against your rent or other Landlord-owed amount.

**Effect on your Landlord-owed balance.** If your authorized payment is fully or partially routed to a GAM balance under this Section 5.5, the amount actually credited to your rent (or other Landlord-owed amount) is reduced by the amount routed. Your Landlord-side ledger reflects only the amount actually received by your Landlord — your rent balance with your Landlord will continue to show unpaid in the amount routed to GAM. **You remain responsible to your Landlord for any unpaid rent that results.** GAM is not liable for any Landlord remedy (late fee, eviction notice, or other action) that arises from rent unpaid because the authorized payment was applied first to a GAM balance.

**Avoiding the routing.** If you do not want a particular payment routed under this Section 5.5, you must pay your Landlord-owed amount through a channel outside the Platform's ACH or card system (e.g., an electronic payment method your Landlord accepts directly) and ensure the GAM-owed amount is satisfied separately. The Platform's payment surfaces are not the only way to pay your rent; payment routing under this Section 5.5 applies only to payments you authorize through the Platform.

### 5.6 Unpaid Rent and Collections

If you fall behind on rent owed to your Landlord, your Landlord has the option, through the Platform, to engage a third-party collections partner (the "**Collections Partner**") to recover the unpaid rent on the Landlord's behalf. **The Collections Partner is engaged solely for landlord-owed unpaid rent.** It is not engaged for any FlexDeposit, FlexPay, or other GAM Service-Level Agreement amount.

If the Collections Partner is engaged:

- The collections activity is subject to the federal Fair Debt Collection Practices Act (15 U.S.C. § 1692 et seq.) and the debt-collection law of your state of residence.
- The Collections Partner will identify itself, the original creditor (your Landlord), and the amount alleged to be owed.
- You may dispute the alleged debt in writing as provided by the Fair Debt Collection Practices Act; the Collections Partner is required to verify the debt before resuming collection.
- If the Collections Partner reports the unpaid rent to a consumer reporting agency, the reporting is subject to the Fair Credit Reporting Act (15 U.S.C. § 1681 et seq.), including your right to dispute inaccurate information with the consumer reporting agency.

**GAM's role on Section 5.6 collections is limited to facilitating the Landlord's engagement of the Collections Partner.** GAM is not the creditor on the unpaid rent (the Landlord is); GAM is not the collector (the Collections Partner is); GAM does not separately furnish unpaid-rent data to consumer reporting agencies on the Landlord's behalf.

**This Section 5.6 has no application to GAM Service-Level Agreement amounts.** Per Section 9.1, GAM does not engage any collections partner, does not pursue legal action, and does not report to consumer reporting agencies for unpaid FlexDeposit Service-Level Agreement installments. Section 5.6 applies only to landlord-owed unpaid rent.

## 6. Tenant Deposits Held by GAM

**For new tenancies entered into on the Platform**, GAM holds your security deposit in a pooled custody account from the date of collection through lease end. Your Landlord does not have direct custody of the deposit and cannot direct disbursement of the principal deposit balance before the deposit-return flow runs.

**Interest on your deposit.** Many states require Landlords (or the holder of the deposit) to accrue and pay interest on tenant deposits at a state-specific rate. Where the state where your unit is located requires interest, GAM calculates interest on the principal deposit amount per the rate in effect for that state during each accrual period and credits the accrued interest to you according to the property's configured cadence (annually on lease anniversary, or at lease end, depending on the property).

**Deposit return at lease end.** At lease end, your Landlord may itemize deductions (cleaning fees, damage charges, unpaid rent, early-termination fees, late fees) against your deposit through the Platform's deposit-return flow. You will receive an itemized statement showing every deduction and the residual amount paid out to you. The Platform automatically sweeps unpaid charges against your deposit at the time of finalization; your Landlord can review and adjust line items before signing the final disbursement.

**Your rights.** GAM does **not** determine the legality, reasonableness, or enforceability of any deposit deduction. Your state's deposit-return law governs the deadlines, the itemization requirements, your right to dispute deductions, and any damages available to you for non-compliance. If you believe a deduction is improper, you may raise the dispute through the Platform's tenant dispute surface, and you retain all rights available to you under the law of the property's state.

## 7. Tenant Screening and Background Checks

When you apply to rent a unit listed on the Platform, your Landlord may request a tenant-screening report from a third-party consumer reporting agency. Your screening consent is collected at the time of application and includes the Fair Credit Reporting Act ("**FCRA**") disclosure required by federal law, plus the additional state-law disclosures required by your state of residence (where applicable: California, Minnesota, Oklahoma, New York, and Washington each have additional disclosures, among others).

**The screening provider is the consumer reporting agency.** If you believe a report about you contains inaccurate information, you have the right under FCRA to dispute the report directly with the screening provider. Your Landlord and GAM are not the consumer reporting agency for purposes of FCRA disputes about report accuracy.

**Adverse-action notices.** If a Landlord declines your rental application based in whole or in part on the contents of a consumer report, the Landlord (through the Platform) will send you an adverse-action notice that includes the contact information of the screening provider and your rights to dispute the report.

## 8. Lease Generation and Electronic Signature

If your tenancy was set up on the Platform, the lease document is generated by your Landlord using the Platform's lease-generation flow, signed electronically by you and your Landlord, and made available to you in the tenant portal for the duration of the tenancy and afterward.

Electronic signature is collected via a flow that is intended to comply with the federal Electronic Signatures in Global and National Commerce Act ("**E-SIGN Act**") and applicable state Uniform Electronic Transactions Acts ("**UETA**"). By signing electronically, you consent to the use of electronic records and signatures in lieu of paper documents.

**GAM does not draft or provide legal advice on the content of your lease.** Your lease is between you and your Landlord. If you have questions about the legal effect of any clause in your lease, consult a tenant-rights attorney or your state's tenant-rights resources.

Material lease modifications and early-termination agreements require both your countersignature and your Landlord's. Routine Landlord-issued notices (e.g., notice of inspection, notice of rent payment receipt) may be delivered through the Platform's audit-trail surface as one-way notices.

## 9. FlexSuite Tenant Products

GAM offers an opt-in suite of products under the FlexSuite brand. **The four products differ materially in who is providing the financial component**, and the disclosures and rights applicable to each depend on that structure. Each product is opt-in only; enrollment requires that you accept the product-specific terms presented at the enrollment surface.

### 9.1 FlexDeposit (deposit installments with GAM custody — not credit)

#### 9.1.1 What FlexDeposit Is

FlexDeposit lets you fund your security deposit in installments while GAM holds the deposit in custody. You opt in **at move-in**. Eligibility is limited to recipients of Social Security Disability Insurance (SSDI) or Supplemental Security Income (SSI) at this time, and your income is verified at enrollment. **FlexDeposit involves no credit check, no credit decision, and no extension of credit.** Your deposit is divided into **between two and six monthly installments based on your deposit amount, as disclosed to you at enrollment.**

**GAM holds your deposit in custody as you fund it; GAM does not advance, lend, or float any portion of your deposit to your Landlord.** Your Landlord's books reflect your deposit in full at move-in, but the funds are held by GAM, not paid to your Landlord. GAM charges a **custody fee of $3.00 per month** for as long as it holds your deposit.

#### 9.1.2 Not a Loan or Credit

The installments you pay under FlexDeposit fund **your own security deposit** — they are not repayment of any advance, loan, or extension of credit, because GAM does not advance or lend anything to you. FlexDeposit is not, and shall not be construed as, a loan, an extension of consumer credit, a "credit transaction" under the Truth in Lending Act (15 U.S.C. § 1601 et seq.) or Regulation Z (12 C.F.R. Part 1026), an extension of credit under the Equal Credit Opportunity Act (15 U.S.C. § 1691 et seq.) or Regulation B (12 C.F.R. Part 1002), a consumer financial product or service under the Consumer Financial Protection Act (12 U.S.C. § 5481 et seq.), a debt under the Fair Debt Collection Practices Act (15 U.S.C. § 1692 et seq.), or a loan or extension of credit under the consumer-finance, consumer-installment-loan, small-loan, or usury statutes of any state. GAM holds your deposit as a custodian; it does not bill you principal or interest and does not charge a finance charge as defined in 12 C.F.R. § 1026.4. The custody fee is consideration for the custody service only.

#### 9.1.3 Custody, Return, and Default

While GAM holds your deposit:

- **At lease end / move-out**, GAM returns the deposit to you through the deposit-return flow in Section 6, less any deductions your Landlord is entitled to take under the lease and applicable law.
- **On your default**, your Landlord's claim is satisfied from the deposit GAM holds for you.
- **Because GAM does not float the deposit, if you have not finished funding it, the amount available to your Landlord and to you is limited to what you have actually paid into custody.**
- Where applicable law requires a security deposit to be held in a separate, escrow, or interest-bearing account, GAM holds it accordingly and pays any required statutory interest. GAM keeps the deposit available for return or disbursement in accordance with the lease and applicable law.

#### 9.1.4 Payment Routing

By enrolling in FlexDeposit, you authorize the payment routing described in Section 5.5: when you authorize an ACH or card payment through the Platform for any amount (including rent), the Platform applies the payment first to any then-due FlexDeposit installment, on a first-in, first-out basis, before settling any remainder to your Landlord. This is the operational mechanism by which your deposit is funded; **it is not a debt-collection mechanism.** You may revoke the ACH authorization at any time by writing to `support@goldassetmanagement.com`; revocation stops further routing to your FlexDeposit installments and may trigger Section 9.1.5.

#### 9.1.5 If You Stop Funding (Service-Tier, Not Debt-Collection)

If you do not make a scheduled installment, your deposit is simply under-funded, and the consequences are limited to the following. **None of these is a debt, debt collection, or credit-reporting action. You do not "owe" GAM, and GAM will not** sue you, obtain a judgment against you, engage any collection agency or debt collector, garnish your wages, lien or seize your property, take a security interest in your deposit or refund, furnish any information about you to a consumer reporting agency, or threaten any of the foregoing.

- Your eligibility to enroll in other FlexSuite products (FlexPay, FlexCharge, FlexCredit) may be restricted until your installments are current.
- At lease end, any portion of the deposit you did not fund is not part of the deposit held for you; your Landlord's deductions and your refund are calculated against the amount actually held.

For the avoidance of doubt: the Collections Partner described in Section 5.6 is engaged only for landlord-owed unpaid rent and has no role in FlexDeposit.

#### 9.1.6 Transfers Between GAM Properties

If you move to another property on the Platform, your deposit is forwarded and **remains in GAM custody — your prior Landlord does not receive a payout on the transfer.** Your new operator's books are updated to reflect the deposit, and **once it is marked in the new operator's books, the $3.00 monthly custody fee dissolves and you will not be charged a further custody fee.** If your new property's required deposit is larger than the amount forwarded, you fund the difference by topping up to GAM through additional monthly installments — not by paying your Landlord.

#### 9.1.7 No Consumer Report for Eligibility

GAM determines your eligibility for FlexDeposit from your existing Platform account data and your verified income — not from a consumer report. **GAM does not obtain a consumer report from any consumer reporting agency for the FlexDeposit eligibility determination.** The determination is not a "credit decision" under the Equal Credit Opportunity Act and is not subject to the Fair Credit Reporting Act's adverse-action requirements. If GAM declines to enroll you, you may request a written explanation by emailing `support@goldassetmanagement.com`; GAM will respond within thirty (30) days.

#### 9.1.8 Bankruptcy

If you commence any bankruptcy, insolvency, receivership, or similar proceeding, GAM may terminate FlexDeposit at its option. GAM will not assert any claim, secured or unsecured, against your bankruptcy estate arising from FlexDeposit, and your deposit — to the extent held by GAM and not subject to your Landlord's lawful deductions — remains returnable to you under Section 6 and applicable law.

### 9.2 FlexPay (Payment-date coordination subscription)

**FlexPay is a payment-scheduling service. It is not a loan or extension of credit.** When you enroll in FlexPay, you select a payment-date arrangement for your rent and other recurring charges — for example, designating a date later in the month for your rent ACH pull, splitting rent into two pulls within the month, or aligning the pull date with your payday. **GAM does not advance any funds on your behalf for FlexPay.** The Platform's payment processor (Stripe) initiates the ACH pull from your bank account on the date you scheduled; if the funds are not available on that date, the pull fails and your account reflects unpaid rent until you bring it current.

**FlexPay is available only to recipients of SSDI or SSI at this time. If you are funding your security deposit through FlexDeposit, you must complete that installment plan before you can enroll in FlexPay. A deposit you have otherwise already paid — including one carried over from before your Landlord joined the Platform — does not affect your FlexPay eligibility.**

FlexPay is a subscription priced on a **date-based formula**:

- **Monthly Fee = $5.00 + ($1.00 × Scheduled Pull Date)**, where the Scheduled Pull Date is the calendar day of each month on which you have scheduled your rent ACH pull.
- The Scheduled Pull Date is capped at the 28th. So the monthly fee ranges from **$6.00** (pull date on the 1st) to **$33.00** (pull date on the 28th).
- Example: a Scheduled Pull Date of the 11th of each month produces a Monthly Fee of $5 + $11 = **$16.00**.
- **Failed pulls re-price.** If your rent ACH pull fails on the Scheduled Pull Date and the Platform retries on a later calendar day under the failed-pull retry policy described in Section 5.4, your FlexPay Monthly Fee for that cycle is **recalculated** using the formula at the actual (retry) pull date. A retry on the 15th, for example, recalculates the cycle's Monthly Fee to $5 + $15 = **$20.00**, replacing the originally-scheduled $16.00. **Plus, any Stripe ACH-return fees that GAM is charged are passed through to you** at GAM's actual cost. The full recalculation mechanics and Stripe pass-through provisions are set out in the FlexPay Subscription Terms § 4.1 and § 4.2.
- The fee is for the scheduling-service access, not for any credit, advance, or money movement on your behalf.
- **Failure and re-enrollment.** Your scheduled pull is retried up to two more times: the second attempt on the next business day, and the final attempt on the third business day after your original due date. A **FlexPay failure** occurs only if all three attempts fail. **Following a FlexPay failure, you may not re-enroll in FlexPay for 90 days.**
- You may change your Scheduled Pull Date at any time through the in-platform FlexPay settings. The change (and the corresponding new Monthly Fee) **takes effect from the next full billing cycle** — it does not alter any pull already scheduled for the current cycle, so an outstanding balance does not block the change.
- You may cancel FlexPay at any time through the in-platform cancellation surface; the cancellation takes effect at the end of the then-current billing cycle.

Because GAM is not advancing funds, **no Truth in Lending Act, FCRA, or state lending-law framework applies to FlexPay.** Auto-renewal of the FlexPay subscription is disclosed at enrollment per the state automatic-renewal laws listed in Section 9.5.

### 9.3 FlexCharge (Business-Account-Owner-extended credit; GAM accounting)

**FlexCharge is a product organized by GAM but not operated by GAM. The Business Account Owner is the creditor.** GAM is not. FlexCharge is an accounting feature that lets a **Business Account Owner** — your Landlord, or a separate point-of-sale ("**POS**") operator who has not also rented you a unit — operate a rolling charge account at a specific Location. It is typical at RV parks, extended-stay properties, and on-site stores or service desks where account holders run a tab for property-store purchases, utilities, services, and other charges. The Business Account Owner sets the credit limit, sets any interest or finance charges, sets the payment cadence, and is the party to whom you owe the charged balance.

You may be either: (a) a Tenant of the Business Account Owner with a lease at the Location; or (b) a POS Customer with no lease, who uses FlexCharge solely to run a charge tab at the Location's POS surface. Your status is recorded at enrollment.

**FlexCharge is enabled per Location.** A Business Account Owner who operates multiple locations may offer FlexCharge at some Locations and not others. You will not see FlexCharge enrollment surfaces, copy, or disclosures with respect to any Location at which the Business Account Owner has not enabled FlexCharge.

GAM's role on FlexCharge is **software only**: the Platform tracks each charge posted by the Business Account Owner, applies your payments, and surfaces the statement to you in your tenant or POS-customer portal. The fee GAM charges for FlexCharge is for that accounting service, not for credit extension. **GAM sets no rules on how a Business Account Owner operates its charge accounts — GAM provides only the ability to offer them — and advises Business Account Owners to operate within their local laws.**

Because the Business Account Owner is the creditor:

- The terms of the charge account (credit limit, any interest or finance charges, payment schedule, default consequences) are between you and the Business Account Owner and are disclosed in the FlexCharge Business Account Agreement you sign with the Business Account Owner at enrollment.
- Any rights you have under Truth in Lending Act, Equal Credit Opportunity Act, Fair Credit Billing Act, Fair Debt Collection Practices Act, state lending law, or state usury law run against the Business Account Owner — not against GAM. The Business Account Owner is responsible for compliance with those laws.
- GAM is not responsible for the Business Account Owner's underwriting decisions, credit-limit settings, finance-charge calculations, or collection activity. Disputes about charges on your FlexCharge account should be raised with the Business Account Owner first; GAM will help facilitate the dispute through the Platform's dispute interface where you elect to use it.
- The Collections Partner integration described in Section 5.6 is **not engaged** on FlexCharge balances; it applies only to unpaid rent owed to a Landlord under a lease.

### 9.4 FlexCredit (Rent-payment credit reporting — not a loan)

**FlexCredit is a credit-reporting service, not a loan, a line of credit, or any extension of credit.** When you opt in to FlexCredit, GAM reports your **positive (on-time) rent payments** to consumer reporting agencies through a third-party registered furnisher, to help you build credit history from rent you already pay. GAM does not lend you money, does not advance funds, and makes no credit decision about you.

- **Opt-in and opt-out.** FlexCredit is voluntary. You may opt out at any time; opting out stops future reporting. Payment history already furnished is handled according to the furnisher's and the consumer reporting agencies' standard rules.
- **No guaranteed result.** Credit scores are determined by the consumer reporting agencies and their scoring models, not by GAM. **GAM does not warranty, guarantee, or promise any particular change to your credit score or any other outcome** from FlexCredit.
- **What is reported.** FlexCredit is designed to report positive payment activity. The third-party furnisher and the consumer reporting agencies maintain and report the data; their identities and the applicable disclosures are presented to you at enrollment.
- **Fees.** Any FlexCredit fee is disclosed at enrollment. **FlexCredit fees are not prorated and are non-refundable.**

### 9.5 Auto-Renewal Disclosures

If a FlexSuite product you enroll in automatically renews on a billing cycle (e.g., a FlexPay monthly subscription), the auto-renewal terms are disclosed at enrollment in compliance with applicable state automatic-renewal laws, including:

- California Business and Professions Code § 17600 et seq.
- New York General Business Law § 527-a
- Massachusetts G.L. c. 93, § 113
- Oregon ORS 646A.295
- New Jersey N.J.S.A. 56:12-14.1

You may cancel an auto-renewing FlexSuite subscription at any time through the in-platform cancellation surface; the cancellation takes effect at the end of the then-current billing cycle. Cancellation of FlexCharge is handled with the Business Account Owner (the creditor) through the Platform. FlexCredit is cancelled by opting out at any time through the in-platform FlexCredit settings, which stops future reporting.

## 10. Refunds

The following refund policy applies to payments through the Platform:

- **Tenant deposits held by GAM** are refundable to you per the deposit-return flow at lease end, less Landlord-approved deductions, in accordance with applicable state law.
- **Tenant payments to Landlords** (rent, utility charges, fee assessments) may be refunded by your Landlord at the Landlord's discretion through the Platform's refund interface. GAM does not initiate, mandate, or guarantee any such refund. If you believe a charge is improper, raise it through the Platform's dispute interface or contact your Landlord directly.
- **Payment-processing fees** (ACH, card) that you paid as a pass-through fee are **non-refundable** by GAM under all circumstances, including when the underlying payment is reversed, refunded, or charged back.
- **FlexSuite subscription fees** (e.g., FlexPay) are refundable only as described in the FlexSuite product-specific terms.

## 11. Prohibited Conduct

You agree that you will **not**, and will not attempt to:

- Use the Platform for any unlawful purpose, including fraud, identity misrepresentation, or evading sanctions law;
- Impersonate any person or entity, or misrepresent your relationship to any property or Landlord;
- Submit false, misleading, or forged information during registration, screening, or payment;
- Interfere with the Platform's operation, including by introducing malware, attempting to defeat rate limits, scraping, reverse-engineering, decompiling, or extracting data via any means other than the surfaces provided to you;
- Use the Platform to send unsolicited bulk communications ("spam") to other Users;
- Share your account credentials with any third party;
- Use the Platform to harass, threaten, or defame any other User;
- Initiate a chargeback for a payment you have already received the benefit of (e.g., rent for a month you occupied), except where the underlying transaction is genuinely unauthorized or in dispute.

We may suspend or terminate your account at our discretion for actual or suspected violation of these prohibitions, including without notice where the violation creates risk to other Users or to the Platform.

## 12. User Content

You retain ownership of the data, documents, photographs, and other content you submit to the Platform ("**User Content**"). By submitting User Content, you grant GAM a worldwide, non-exclusive, royalty-free, sublicensable license to host, store, reproduce, display, and process the User Content for the limited purpose of operating the Platform and providing the service to you.

You represent that you have all necessary rights to grant this license and that your User Content does not violate any third party's intellectual property, privacy, or other rights.

GAM may remove or refuse to display User Content that we reasonably believe violates these Terms, applicable law, or the rights of others. We have no obligation to monitor User Content but may do so at our discretion.

## 13. Intellectual Property

The Platform, including its software, design, branding, gold-and-dark aesthetic, logos, copy, and all derivative works, is the property of GAM or its licensors and is protected by copyright, trademark, and other intellectual property laws. Subject to your compliance with these Terms, GAM grants you a limited, non-exclusive, non-transferable, revocable license to access and use the Platform.

You may not copy, modify, distribute, sell, lease, or create derivative works of the Platform; reverse-engineer or attempt to derive source code from the Platform; or remove any proprietary notices.

## 14. Third-Party Services

The Platform integrates with third-party services to deliver its features. Current third-party services include:

- **Stripe** (payment processing, Identity verification, Financial Connections bank verification)
- **Resend** (transactional email delivery)
- **Plaid** (bank account verification, where used in the ACH onboarding flow)
- **The screening provider** identified at the time you authorize tenant screening
- **Sentry** (error tracking and monitoring)

Each third-party service is subject to its own terms of service and privacy policy. GAM does not control these third parties and is not responsible for their acts or omissions, except as required by applicable data-protection law. We may add, remove, or substitute third-party services at our discretion.

## 15. Disclaimers

THE PLATFORM IS PROVIDED ON AN "**AS IS**" AND "**AS AVAILABLE**" BASIS. GAM USES COMMERCIALLY REASONABLE EFFORTS TO PROVIDE A FUNCTIONING, SECURE PLATFORM, BUT DOES NOT WARRANT THAT THE PLATFORM WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE; THAT DEFECTS WILL BE CORRECTED; OR THAT THE PLATFORM WILL MEET YOUR EVERY REQUIREMENT.

GAM IS NOT YOUR LANDLORD AND IS NOT A REAL ESTATE BROKER, ATTORNEY, ACCOUNTANT, OR FINANCIAL ADVISOR. NO PORTION OF THE PLATFORM CONSTITUTES LEGAL, TAX, FINANCIAL, OR INVESTMENT ADVICE FOR YOU AS A TENANT. IF YOU HAVE QUESTIONS ABOUT YOUR LEASE, YOUR RIGHTS AS A TENANT, OR THE LEGAL EFFECT OF ANY PLATFORM FEATURE, CONSULT A TENANT-RIGHTS ATTORNEY OR YOUR STATE'S TENANT-RIGHTS RESOURCES.

NOTHING IN THIS SECTION LIMITS YOUR NON-WAIVABLE RIGHTS UNDER STATE OR FEDERAL CONSUMER-PROTECTION LAW, FAIR CREDIT REPORTING LAW, OR YOUR RIGHTS AS A TENANT UNDER THE LAW OF THE PROPERTY'S STATE.

Some jurisdictions do not allow the exclusion of certain warranties, so some of these exclusions may not apply to you.

## 16. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL GAM BE LIABLE TO YOU FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST REVENUE, LOST GOODWILL, OR LOSS OF DATA, ARISING OUT OF OR RELATED TO THE PLATFORM OR THESE TERMS, WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR OTHERWISE, EVEN IF GAM HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

GAM'S AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THESE TERMS OR THE PLATFORM IS LIMITED TO THE GREATER OF (a) THE TOTAL FEES YOU PAID DIRECTLY TO GAM (INCLUDING FLEXSUITE SUBSCRIPTION FEES AND PASS-THROUGH PROCESSING FEES YOU PAID AT CHECKOUT) IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR (b) ONE HUNDRED DOLLARS ($100), WHICHEVER IS GREATER, SUBJECT TO THE CARVE-OUTS BELOW.

**THIS LIMITATION DOES NOT APPLY TO**, AND THE FOREGOING CAP DOES NOT REACH, ANY OF THE FOLLOWING:

- (i) GAM'S OWN FRAUD, WILLFUL MISCONDUCT, OR GROSS NEGLIGENCE;
- (ii) GAM'S VIOLATION OF THE FAIR CREDIT REPORTING ACT (FCRA), THE FAIR HOUSING ACT, OR ANY STATE-LAW EQUIVALENT;
- (iii) GAM'S VIOLATION OF CONSUMER-PROTECTION STATUTES, INCLUDING THE CALIFORNIA UNFAIR COMPETITION LAW (Cal. Bus. & Prof. Code § 17200), CALIFORNIA CONSUMERS LEGAL REMEDIES ACT (Cal. Civ. Code § 1750 et seq.), CALIFORNIA FALSE ADVERTISING LAW (Cal. Bus. & Prof. Code § 17500), NEW JERSEY CONSUMER FRAUD ACT (N.J.S.A. 56:8-1 et seq.), MASSACHUSETTS CHAPTER 93A, OREGON UNLAWFUL TRADE PRACTICES ACT (ORS 646.605 et seq.), AND ANALOGOUS LAWS IN OTHER STATES;
- (iv) GAM'S OBLIGATION TO RETURN YOUR DEPOSIT (LESS LANDLORD-APPROVED DEDUCTIONS) PER SECTION 6;
- (v) ANY OBLIGATION OF GAM TO INDEMNIFY YOU; OR
- (vi) ANY LIABILITY THAT CANNOT BE LIMITED OR EXCLUDED AS A MATTER OF LAW IN YOUR STATE OF RESIDENCE.

THESE LIMITATIONS APPLY EVEN IF AN EXCLUSIVE REMEDY FAILS OF ITS ESSENTIAL PURPOSE, EXCEPT TO THE EXTENT YOUR STATE'S LAW PROVIDES OTHERWISE. SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF INCIDENTAL OR CONSEQUENTIAL DAMAGES, SO PORTIONS OF THIS SECTION MAY NOT APPLY TO YOU.

## 17. Indemnification

You agree to defend, indemnify, and hold harmless GAM and its affiliates from and against any and all claims, damages, obligations, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising from:

- (i) Your User Content;
- (ii) Your breach of these Terms;
- (iii) Your violation of applicable law in connection with your use of the Platform; or
- (iv) Your infringement of any third party's intellectual property or privacy rights.

**You are not obligated to indemnify GAM for** (a) GAM's own acts or omissions, (b) the acts or omissions of any other User (including your Landlord), (c) any claim arising from a statutory violation by GAM, or (d) any claim that GAM is the proximate cause of.

## 18. Termination

### 18.1 Termination by You

You may close your Platform account at any time through the account-settings surface or by contacting `support@goldassetmanagement.com`. Closing your account ends your access to the Platform but does not, by itself, terminate your underlying lease with your Landlord. Your lease remains in effect according to its terms.

If you close your account during an active tenancy, your Landlord can continue to collect rent and post charges to the lease outside the Platform; the Platform's record of those charges may continue to be updated to reflect the outcome of the deposit-return flow at lease end.

### 18.2 Termination by GAM

GAM may suspend or terminate your account, with or without notice, for any of the following:

- Material breach of these Terms (including a chargeback pattern on rent already received);
- Suspected fraud or unlawful use of the Platform;
- Operational, security, or regulatory necessity;
- Sustained inactivity (no login for thirty-six (36) months, after which a re-engagement notice is sent).

Upon termination, your right to access the Platform ceases immediately. We may retain your data per the [Consumer Privacy Policy](./CONSUMER_PRIVACY_POLICY.md) and applicable record-retention laws.

## 19. Dispute Resolution; Binding Arbitration; Class Action Waiver

**PLEASE READ THIS SECTION CAREFULLY. IT AFFECTS YOUR LEGAL RIGHTS, INCLUDING YOUR RIGHT TO BRING A CLAIM IN COURT AND YOUR RIGHT TO PARTICIPATE IN A CLASS ACTION.**

**BY AGREEING TO ARBITRATION IN THIS SECTION 19, YOU ARE GIVING UP YOUR RIGHT TO BRING A CLAIM IN COURT, INCLUDING YOUR RIGHT TO A JURY TRIAL.** The arbitrator decides the dispute, not a judge or jury. Court rules of evidence and procedure do not apply in arbitration. Appeal rights from an arbitrator's decision are limited. This is a major decision; if you do not want it to apply to you, see the opt-out in Section 19.5 below.

### 19.1 Informal Resolution

Before initiating any formal dispute, you agree to first contact GAM at `support@goldassetmanagement.com` and provide a written description of the dispute, including the nature of the claim and the relief sought. GAM and you agree to attempt to resolve the dispute through good-faith negotiation for at least thirty (30) days from receipt of the notice.

### 19.2 Binding Arbitration

If the dispute is not resolved within thirty (30) days, you and GAM agree that any claim, controversy, or dispute arising out of or relating to these Terms or the Platform (a "**Dispute**") will be resolved exclusively through final and binding arbitration administered by the American Arbitration Association ("**AAA**") under its then-current Consumer Arbitration Rules. The arbitration will be conducted by a single arbitrator, in English.

**Seat of arbitration for consumer claims.** Individual arbitration of a Dispute under these Consumer Terms will be seated in the state of your residence at the time the claim is filed, at your election. If you do not designate a seat, the arbitration will be seated in your state of residence by default. The arbitrator may conduct the arbitration by telephone, videoconference, or in writing; an in-person hearing will be held only at the parties' joint request or the arbitrator's order on good cause shown.

The arbitrator has exclusive authority to resolve any Dispute relating to the interpretation, applicability, enforceability, or formation of this arbitration agreement, including any claim that all or any part of this arbitration agreement is void or voidable, except as provided in Section 19.4 regarding public injunctive relief.

The Federal Arbitration Act (9 U.S.C. §§ 1 et seq.) governs the interpretation and enforcement of this arbitration agreement. The arbitrator's award will be final and binding, and judgment on the award may be entered in any court of competent jurisdiction.

### 19.3 Class Action Waiver

**You and GAM agree that any Dispute will be resolved on an individual basis only. Neither you nor GAM will be entitled to join or consolidate Disputes by or against other Users, or to litigate any Dispute as a representative or member of a class, collective action, or private attorney general action.** The arbitrator may not consolidate more than one party's claims and may not preside over any form of representative or class proceeding.

If a court of competent jurisdiction determines that this class action waiver is unenforceable as to a particular claim, then only that claim will be severed from arbitration and brought in court, and the remainder of this Section 19 (including arbitration of the rest of any Dispute and the class waiver as to other claims) will remain in full force.

### 19.4 California Public Injunctive Relief Carve-Out

**Notwithstanding anything in this Section 19 to the contrary, the right to seek public injunctive relief on behalf of the general public under the California Unfair Competition Law (Bus. & Prof. Code § 17200), the California Consumers Legal Remedies Act (Civ. Code § 1750 et seq.), or the California False Advertising Law (Bus. & Prof. Code § 17500) is preserved in court.** A claim for public injunctive relief under these statutes is severable from arbitration. The class action waiver in Section 19.3 does not apply to a claim for public injunctive relief brought in court under California law. This carve-out is itself severable; if held unenforceable, it shall be severed and the remainder of Section 19 shall remain in full force.

### 19.5 Other Carve-Outs

Notwithstanding the foregoing:

- Either party may bring an individual action in small-claims court for any Dispute within the small-claims court's jurisdictional limits;
- Either party may seek injunctive or other equitable relief in court to protect its intellectual property, confidential information, or trade secrets pending arbitration;
- Nothing in this Section 19 prevents you from filing a complaint with a federal, state, or local government agency that has jurisdiction over your claim.

### 19.6 Thirty-Day Opt-Out

You may opt out of the arbitration and class action waiver in this Section 19 by sending written notice of your decision to opt out to `support@goldassetmanagement.com` (with "Arbitration Opt-Out" in the subject line) within thirty (30) days of first agreeing to these Terms. Your opt-out notice must include your full legal name, account email, and a clear statement that you wish to opt out. If you opt out, the remainder of these Terms continues to apply.

## 20. Governing Law and Venue

These Terms are governed by the laws of the State of Delaware, without regard to its conflict-of-laws principles, **except** that:

- (a) Nothing in this Section 20 displaces, waives, or limits any non-waivable right you have under the consumer-protection or tenant-protection law of your state of residence;
- (b) Where the law of your state of residence provides protections that are more favorable to you than Delaware law on a given issue (including limitation of liability, indemnification, lease-related obligations, consumer fraud, or fair credit reporting), those protections apply;
- (c) For any Dispute not subject to arbitration, you may bring the action either in the state and federal courts located in Wilmington, Delaware, **or** in a court of competent jurisdiction in your state of residence, at your election.

## 21. Surviving Provisions

The following Sections survive termination of these Terms for any reason: Section 5 (Payment Processing, to the extent of accrued obligations), Section 6 (Tenant Deposits, until your deposit is returned per the deposit-return flow), Section 10 (Refunds), Section 12 (User Content, license to retain residual copies), Section 13 (Intellectual Property), Section 15 (Disclaimers), Section 16 (Limitation of Liability), Section 17 (Indemnification, scoped per Section 17), Section 19 (Dispute Resolution, including the public-injunctive carve-out), Section 20 (Governing Law, including the consumer savings clause), and this Section 21.

## 22. Changes to These Terms

GAM may revise these Terms from time to time.

**Non-material updates** (clarifications, typo fixes, adjustments that do not affect your rights or obligations) take effect upon notice to you by email and in-platform notification at least thirty (30) days before the effective date. Your continued use of the Platform after the effective date constitutes acceptance.

**Material changes** — changes to the dispute-resolution provisions, the class-action waiver, the limitation of liability, the indemnification, fees you pay, choice-of-law/venue, the FlexSuite product terms, or any other change that materially affects your rights or obligations — require your **affirmative click-through re-acceptance** before continued use. Continued use without re-acceptance is not acceptance, and you may close your account before the material change takes effect.

We will maintain prior versions of these Terms for thirty-six (36) months after they are superseded.

## 23. General

### 23.1 Entire Agreement

These Terms, together with the [Consumer Privacy Policy](./CONSUMER_PRIVACY_POLICY.md), the service-specific FlexSuite terms referenced in Section 1, the lease electronic-signature consent, the screening authorization, and the Stripe terms applicable to your payment method, constitute the entire agreement between you and GAM regarding the Platform and supersede all prior or contemporaneous communications. **These Terms do not modify, replace, or supersede the lease between you and your Landlord.**

### 23.2 No Waiver

GAM's failure to enforce any right or provision of these Terms is not a waiver of that right or provision. Any waiver must be in writing and signed by an authorized representative of GAM.

### 23.3 Severability

If any provision of these Terms is held unenforceable, that provision will be modified to the minimum extent necessary to be enforceable, or, if modification is not possible, severed, and the remaining provisions will remain in full force.

### 23.4 Assignment

You may not assign or transfer these Terms or your account without GAM's prior written consent. GAM may assign these Terms without restriction, including in connection with a merger, acquisition, reorganization, or sale of all or substantially all of its assets.

### 23.5 Force Majeure

GAM is not liable for any failure or delay in performance caused by events beyond its reasonable control, including without limitation natural disasters, war, terrorism, civil disorder, labor disputes, pandemics, third-party service outages (including Stripe outages), or governmental action.

### 23.6 Notices

GAM may send notices to you by email to the address on your account, by in-platform notification, or by mail to the address you have provided. You may send notices to GAM at:

Gold Asset Management LLC
Attn: Legal
2843 East Frontage Road
Amado, AZ 85645

Email: `support@goldassetmanagement.com`

### 23.7 Headings

Headings in these Terms are for convenience only and do not affect interpretation.

### 23.8 Relationship of the Parties

Nothing in these Terms creates any agency, partnership, joint venture, employment, or fiduciary relationship between you and GAM. **GAM is not a party to your lease and is not your Landlord.**

## 24. Automated Systems and AI Agents

The Platform operates in part through automated systems and AI-assisted agents that may communicate with you, generate documents and notices, schedule and process activity, and perform routine actions within the Platform. **Where an automated or AI agent presents an action for your review, you are responsible for confirming the action before it is taken, and you are responsible for any action you confirm or direct the agent to take.** These systems may occasionally make an error or take an incorrect action; GAM may review, correct, reverse, or adjust any erroneous action, entry, communication, or record produced by such systems, and you authorize GAM to make those corrections. Automated or AI-generated communications are operational tools — they are not legal, tax, or financial advice and do not replace your own judgment. GAM's responsibility for the actions of its automated systems is governed by the Disclaimers and Limitation of Liability sections, and you agree to promptly notify GAM of any error you identify so it can be corrected.

## 25. Communications and Consent to Contact

You consent to receive communications from GAM — including account, billing, transaction, security, and service messages — by email, SMS/text message, push notification, and telephone, **including messages sent using automated or autodialed systems and prerecorded or AI-generated voices**, at the email address and phone numbers you provide. Message and data rates may apply and message frequency varies. **Consent to receive marketing communications is not a condition of using the Platform.** You may opt out of marketing communications at any time (for example, by replying STOP to a marketing text or using an unsubscribe link), but you may not opt out of operational and transactional messages necessary to provide the service while you maintain an account. You are responsible for keeping your contact information current and will promptly notify GAM if you stop using a phone number you provided.

---

## Contact

Questions about these Terms? Email `support@goldassetmanagement.com` or write to:

Gold Asset Management LLC
2843 East Frontage Road
Amado, AZ 85645
