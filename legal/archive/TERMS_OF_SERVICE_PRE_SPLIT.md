# Terms of Service

**Gold Asset Management**
2843 East Frontage Road, Amado, AZ 85645
Effective Date: [DATE OF PUBLIC LAUNCH]
Last Updated: [DATE]

---

## 1. Agreement to These Terms

These Terms of Service (the "**Terms**") form a binding legal agreement between you and **Gold Asset Management LLC**, a Delaware limited liability company with its principal place of business at 2843 East Frontage Road, Amado, Arizona 85645 ("**GAM**," "**we**," "**us**," or "**our**").

By creating an account, accessing, or otherwise using the GAM platform — including the websites, mobile-responsive portals, APIs, and related services we operate under the Gold Asset Management brand (collectively, the "**Platform**") — you agree to these Terms and to the [Privacy Policy](./PRIVACY_POLICY.md), which is incorporated by reference. If you do not agree, you must not use the Platform.

You also agree to the additional service-specific terms presented within the Platform (e.g., the FlexDeposit disclosure, lease electronic-signature consent, and background-check authorization). Those service-specific terms are incorporated by reference and prevail to the extent they conflict with these Terms for the specific feature they govern.

## 2. Eligibility

You may only use the Platform if:

- You are at least 18 years of age;
- You have the legal capacity to enter into a binding contract under the law of your state of residence;
- You are not barred from using the Platform under United States law or the law of your jurisdiction; and
- You will use the Platform in compliance with all applicable laws.

If you are using the Platform on behalf of an entity (a property-owning LLC, a property-management company, a trust, etc.), you represent that you are authorized to bind that entity to these Terms, and "you" includes both you and the entity.

## 3. Description of the Platform

GAM is a multi-portal real estate operations platform serving landlords, tenants, property managers, third-party property management companies, and ancillary roles (maintenance workers, on-site managers, bookkeepers). The Platform provides features that may include, depending on your account type:

- Property and unit management
- Tenant onboarding, screening (via third-party providers), and lease management
- Electronic signature for leases and addenda
- Rent collection and disbursement via Stripe Connect Express (the "**Payment Rail**")
- Tenant deposit handling, including optional GAM-held escrow
- Maintenance ticket workflow
- Bookkeeping and reporting features
- Point-of-sale and inventory features for property-operated storefronts (e.g., RV park stores)
- Property intelligence and listings surfaces
- Communications between landlords, tenants, and property managers

GAM is **not** a real estate broker, mortgage lender, escrow agent in the regulated sense, attorney, accountant, tax advisor, or fiduciary. We provide software that helps you operate your real estate business; you remain responsible for compliance with the laws governing your relationship with your tenants, employees, contractors, and counterparties.

## 4. Account Registration and Security

To use most Platform features you must register an account. You agree to:

- Provide accurate, current, and complete information during registration and keep it up to date;
- Maintain the security of your password and any other authentication credentials, including two-factor authentication where required;
- Notify GAM promptly at `support@goldassetmanagement.com` if you suspect unauthorized access; and
- Take responsibility for all activity that occurs under your account.

We may require additional verification (including identity verification through Stripe Identity, address confirmation, or business-entity documentation) before enabling certain features, particularly those that involve money movement.

We may refuse, suspend, or terminate accounts at our discretion, including without limitation when we believe an account is being used in violation of these Terms, is the subject of a fraud or chargeback pattern, or has been requested to be terminated by a third-party processor.

## 5. Roles and User Types

The Platform distinguishes between several user roles, each subject to its own set of permissions, surfaces, and obligations under these Terms:

- **Landlords / Property Owners** — The user or entity that owns one or more rental properties listed on the Platform and is responsible for the landlord-side obligations of each lease.
- **Tenants** — Individuals who rent units listed on the Platform and pay rent through the Payment Rail.
- **Property Managers** — Employees or contractors of a Landlord with delegated access to operate specific properties or units.
- **PM Companies** — Third-party property management organizations contracted by Landlords to operate properties; PM Companies receive a contractual cut of rent collected via the Payment Rail.
- **Ancillary Roles** — Maintenance workers, on-site managers, bookkeepers, and similar roles granted scoped permissions by a Landlord or PM Company.

Each Landlord is responsible for any sub-user (Property Manager, PM Company staff, maintenance worker, bookkeeper) it invites or authorizes on the Platform. Each PM Company is responsible for its staff.

GAM is not a party to the lease agreement between a Landlord and a Tenant, nor to the management agreement between a Landlord and a PM Company. Those agreements are between those parties.

## 6. Payment Processing and the Payment Rail

### 6.1 Stripe Connect Express

GAM uses Stripe, Inc. ("**Stripe**") as its payment processor. All inbound payments (tenant rent, fees) and outbound payouts (landlord disbursements, PM company fees) move through Stripe Connect Express. By using the Platform's payment features, you also agree to the [Stripe Connect Services Agreement](https://stripe.com/connect-account/legal/full) and [Stripe Services Agreement](https://stripe.com/legal/ssa) as applicable to your role.

Landlords and PM Companies are required to complete Stripe-hosted Connect onboarding (including identity verification, business verification, and bank account linking) before receiving any funds through the Platform. GAM does not custody funds intended for Landlords or PM Companies; those funds settle to the recipient's Stripe Connect balance and are paid out per the recipient's Stripe payout schedule, subject to any holds, reserves, or freezes that Stripe may impose at its discretion.

### 6.2 Fees and Pricing

GAM charges fees for use of the Platform, including:

- **ACH payment processing**: 1.0% of the transaction amount, capped at $6.00 per transaction.
- **Card payment processing**: 3.25% of the transaction amount, flat (no cap). A 1.5% surcharge is added to charges paid with a non-United States–issued card, passed through to the cardholder.
- **Per-occupied-unit platform fee** (long-term tenancies): $2.00 per occupied unit per month, with a minimum of $10.00 per property per month. Vacant units are not charged.
- **Short-term-stay aggregate platform fee** (nightly and weekly bookings): $2.00 for every aggregate thirty (30) booked nights across the property, counted continuously across all bookings. **Cancellations do not reverse, refund, or otherwise reduce this accrual** — once a booking is recorded, its nights count toward the running total whether or not the guest ultimately stays. This fee applies in lieu of the per-occupied-unit fee for properties operated in short-term-stay (RV nightly or weekly) mode.
- **Connect account fee**: $1.00 per active Connect account per month, waived once the associated landlord or PM company has ten or more billable units.

Pricing for additional services (background checks, screening, FlexSuite products, point-of-sale, etc.) is disclosed in the Platform at the point of use.

Per-property settings determine whether banking fees (ACH and card processing) are paid by the tenant (passed through at checkout) or by the landlord (deducted from the landlord's settlement). Platform fees are paid by the landlord by default but may be configured per property to pass through to the tenant. **In no case will GAM absorb processing or banking fees on a landlord's or tenant's behalf.**

GAM reserves the right to change its fees prospectively with thirty (30) days' notice via email or in-platform notification. Continued use of the Platform after the effective date constitutes acceptance of the new pricing. Existing transactions in flight are honored at the pricing in effect when initiated.

### 6.3 No Cash, No Check

The Platform supports electronic payments only (ACH and card). Cash, checks, money orders, and other paper instruments are not supported. Any in-person collections must be handled outside the Platform; the Tenant's Platform account will continue to reflect the unpaid balance until the Tenant converts the payment to an electronic method.

### 6.4 Chargebacks, ACH Returns, and Disputes

GAM, as the merchant of record on the Payment Rail, is responsible for handling cardholder disputes, ACH returns, and chargebacks through Stripe's dispute interface. We may pursue reversal, set-off, or recovery against any party whose conduct caused the dispute (e.g., a tenant who initiated a chargeback for rent already received and acknowledged). You authorize us to debit or hold funds in your Connect balance to satisfy chargebacks, ACH returns, refunds, and related fees attributable to your account.

### 6.5 Snapshot Routing

Each ledger entry written by the Platform's allocation engine records the destination Stripe Connect account at the time of allocation. Re-pointing a Connect account to a different bank, business entity, or successor account after allocation does **not** retroactively re-route funds already allocated. You are responsible for keeping your Connect-linked banking information current.

## 7. Tenant Deposits

### 7.1 Custody by Default; Migration Carve-Out

**For all new tenancies entered into on the Platform**, GAM holds the tenant deposit in pooled custody from the date of collection through lease end. The Landlord may not elect to take custody of the deposit on a new tenancy and may not direct disbursement of the principal deposit balance before the deposit-return flow runs. GAM holding deposits in this manner is for operational custody only and does not create a fiduciary relationship.

**For tenancies migrated onto the Platform during onboarding** (i.e., existing tenancies brought over from a prior property-management system, where the deposit was already in the Landlord's possession at the time of migration), the Landlord may retain custody of the existing deposit on a per-tenancy basis. Landlords retaining custody of migrated deposits remain solely responsible for safekeeping, segregation (where required by state law), interest accrual and payment, and timely return of the deposit under the law of the property's state.

**Voluntary transfer to GAM custody is encouraged.** Landlords retaining custody of migrated deposits may elect to transfer custody of any held deposit to GAM at any time during the tenancy. GAM provides this option to simplify deposit accounting, ensure consistent state-mandated interest accrual, and reduce the Landlord's individual liability for safekeeping. Once a deposit is transferred to GAM custody, it is treated as a GAM-held deposit for all purposes of these Terms.

### 7.2 State-Mandated Interest

Many states require Landlords to accrue and pay interest on tenant deposits at a state-specific rate. The Platform maintains a catalog of state deposit interest rates and applies the applicable rate to deposits held during the tenancy. Interest accrues on the principal deposit amount per the rate in effect for the property's state during each accrual period. Where the state's published rate is variable, Landlords are responsible for setting the applicable rate for each accrual year via the Platform's Landlord-Override surface.

Accrued interest is paid out either annually, on the lease anniversary, or at the time of deposit return, per the property's configured cadence. Interest accrual is calculated by the Platform; payment of the interest to the Tenant is the Landlord's obligation for any deposit the Landlord has retained custody of (i.e., a migrated tenancy where the Landlord has not voluntarily transferred custody to GAM) and is handled automatically by the Platform for any deposit in GAM custody.

### 7.3 Deposit Return

At lease end, the Platform's deposit-return flow allows the Landlord to itemize deductions (cleaning fees, damage charges, unpaid rent, early termination fees, late fees) against the held deposit. The Platform sweeps unpaid charges against the deposit automatically at finalize; the Landlord can review and adjust line items before signing the disbursement. The Tenant receives an itemized statement and the residual amount.

GAM does **not** determine the legality, reasonableness, or enforceability of any deposit deduction. The Landlord is solely responsible for compliance with the deposit-return statutes of the property's state, including statutory deadlines, itemization requirements, and any award of multiple damages for non-compliance.

## 8. Refunds

The following refund policy applies to all transactions on the Platform:

- **Payment processing fees** (ACH, card, Connect, platform) are **non-refundable** under all circumstances, including when the underlying payment is reversed, refunded, or charged back.
- **GAM platform fees** (the $2/occupied-unit fee, the $10/property minimum, and any other service fee charged by GAM) are **non-refundable** under all circumstances.
- **Tenant deposits in GAM-escrow custody** are refundable to the Tenant per the deposit-return flow at lease end, less Landlord-approved deductions, in accordance with applicable state law.
- **Tenant payments to Landlords** (rent, utility charges, fee assessments) may be refunded by the Landlord at the Landlord's discretion through the Platform's refund interface. GAM does not initiate, mandate, or guarantee any such refund.
- GAM does **not** refund any payment for services rendered, even if a User claims dissatisfaction. Disputes about Platform functionality should be raised through `support@goldassetmanagement.com`; GAM will work in good faith to resolve operational issues but is not obligated to refund.

## 9. Tenant Screening and Background Checks

When a Landlord requests tenant screening through the Platform, the Platform integrates with a third-party consumer reporting agency to obtain background, credit, eviction-history, and identity reports on prospective Tenants. The current screening provider is disclosed within the screening flow at the time the report is ordered.

Tenants applying through the Platform consent to the running of consumer reports at the point of application. The consent flow includes the Fair Credit Reporting Act ("FCRA") disclosure required by federal law and, where applicable, the additional state-law disclosures (California, Minnesota, Oklahoma, New York, and Washington). Adverse-action notices are sent through the Platform when a Landlord declines an application based in whole or in part on the contents of a consumer report.

**GAM is not the consumer reporting agency.** The third-party screening provider is the consumer reporting agency under the FCRA, and any dispute about the contents of a screening report must be directed to that provider. GAM provides the integration; the provider determines the accuracy of the report.

## 10. Lease Generation and Electronic Signature

The Platform offers a lease-generation flow that produces lease agreements based on Landlord-configured terms. The generated lease is a starting template; **Landlords are responsible for reviewing each lease for compliance with the law of the property's state and for any clause specific to the property or tenancy.** GAM does not draft or provide legal advice on lease content.

Lease signatures are collected via the Platform's electronic-signature flow, which is intended to comply with the federal Electronic Signatures in Global and National Commerce Act ("E-SIGN Act") and applicable state Uniform Electronic Transactions Acts ("UETA"). By signing electronically, you consent to the use of electronic records and signatures in lieu of paper documents.

Landlord-issued addenda and notices may be delivered through the Platform's audit-trail surface as one-way notices to the Tenant. Material lease modifications and early-termination agreements require Tenant countersignature.

## 11. Prohibited Conduct

You agree that you will **not**, and will not attempt to:

- Use the Platform for any unlawful purpose, including drug trafficking, money laundering, fraud, identity misrepresentation, or evading tax or sanctions law;
- Discriminate against any Tenant, applicant, or other User in violation of the federal Fair Housing Act, the Americans with Disabilities Act, or any state or local equivalent;
- Impersonate any person or entity, or misrepresent your relationship to a Landlord, Tenant, or property;
- Submit false, misleading, or forged information during registration, screening, or payment;
- Interfere with the Platform's operation, including by introducing malware, attempting to defeat rate limits, scraping, reverse-engineering, decompiling, or extracting data via any means other than the surfaces provided to you;
- Use the Platform to send unsolicited bulk communications ("spam") to other Users;
- Resell, sublicense, or commercially exploit Platform features outside the scope of your role's permissions;
- Share your account credentials with any third party, except through the Platform's invited sub-user surfaces;
- Use the Platform to harass, threaten, or defame any other User;
- Use the Platform to facilitate housing arrangements that would expose the Landlord, GAM, or any other party to liability under federal or state law (e.g., renting units that fail habitability standards, knowingly enabling occupancy of condemned property, etc.).

We may suspend or terminate any account at our discretion for actual or suspected violation of these prohibitions, including without notice where the violation creates risk to other Users or to the Platform.

## 12. User Content

You retain ownership of the data, documents, photographs, and other content you submit to the Platform ("**User Content**"). By submitting User Content, you grant GAM a worldwide, non-exclusive, royalty-free, sublicensable license to host, store, reproduce, display, and process the User Content for the limited purpose of operating the Platform and providing the service to you.

You represent that you have all necessary rights to grant this license and that your User Content does not violate any third party's intellectual property, privacy, or other rights.

GAM may remove or refuse to display User Content that we reasonably believe violates these Terms, applicable law, or the rights of others. We have no obligation to monitor User Content but may do so at our discretion.

## 13. Intellectual Property

The Platform, including its software, design, branding, gold-and-dark aesthetic, logos, copy, and all derivative works, is the property of GAM or its licensors and is protected by copyright, trademark, and other intellectual property laws. Subject to your compliance with these Terms, GAM grants you a limited, non-exclusive, non-transferable, revocable license to access and use the Platform in accordance with your role.

You may not copy, modify, distribute, sell, lease, or create derivative works of the Platform; reverse-engineer or attempt to derive source code from the Platform; or remove any proprietary notices.

## 14. Third-Party Services

The Platform integrates with third-party services to deliver its features. Current third-party services include:

- **Stripe** (payment processing, Connect, Identity, Radar, Financial Connections)
- **Resend** (transactional email delivery)
- **Plaid** (bank account verification, where used in the ACH onboarding flow)
- **Checkr** (background checks and tenant screening, when activated)
- **Sentry** (error tracking and monitoring)

Each third-party service is subject to its own terms of service and privacy policy. GAM does not control these third parties and is not responsible for their acts or omissions, except as required by applicable data-protection law. We may add, remove, or substitute third-party services at our discretion.

## 15. Disclaimers

THE PLATFORM IS PROVIDED ON AN "**AS IS**" AND "**AS AVAILABLE**" BASIS, WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY. TO THE MAXIMUM EXTENT PERMITTED BY LAW, GAM DISCLAIMS ALL WARRANTIES, INCLUDING WITHOUT LIMITATION THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, AND QUIET ENJOYMENT.

GAM DOES NOT WARRANT THAT THE PLATFORM WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE; THAT DEFECTS WILL BE CORRECTED; THAT THE PLATFORM WILL MEET YOUR REQUIREMENTS; OR THAT ANY DATA WILL BE PRESERVED WITHOUT LOSS.

WITHOUT LIMITING THE FOREGOING, GAM IS NOT A REAL ESTATE BROKER, MORTGAGE LENDER, ATTORNEY, ACCOUNTANT, TAX ADVISOR, OR INVESTMENT ADVISOR. NO PORTION OF THE PLATFORM CONSTITUTES LEGAL, TAX, FINANCIAL, OR INVESTMENT ADVICE. YOU ARE SOLELY RESPONSIBLE FOR COMPLIANCE WITH ALL FEDERAL, STATE, AND LOCAL LAWS GOVERNING YOUR PROPERTY, YOUR TENANTS, YOUR EMPLOYEES OR CONTRACTORS, AND YOUR BUSINESS.

THE PLATFORM SURFACES INFORMATION (INCLUDING DEPOSIT INTEREST RATES, TAX FORM DEADLINES, AND OTHER STATE-SPECIFIC DATA) FOR YOUR CONVENIENCE. GAM USES REASONABLE EFFORTS TO KEEP THIS INFORMATION CURRENT, BUT MAKES NO WARRANTY THAT IT IS COMPLETE, ACCURATE, OR UP-TO-DATE FOR EVERY JURISDICTION AT EVERY POINT IN TIME. YOU ARE RESPONSIBLE FOR INDEPENDENTLY VERIFYING ANY DEADLINE, RATE, OR REGULATORY REQUIREMENT BEFORE ACTING ON IT.

Some jurisdictions do not allow the exclusion of certain warranties, so some of these exclusions may not apply to you.

## 16. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL GAM, ITS AFFILIATES, OR ITS OFFICERS, DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST REVENUE, LOST GOODWILL, OR LOSS OF DATA, ARISING OUT OF OR RELATED TO THE PLATFORM OR THESE TERMS, WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR OTHERWISE, EVEN IF GAM HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

GAM'S AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THESE TERMS OR THE PLATFORM IS LIMITED TO THE TOTAL **PLATFORM FEES** YOU PAID TO GAM IN THE NINETY (90) DAYS IMMEDIATELY PRECEDING THE EARLIER OF (i) THE EVENT GIVING RISE TO THE CLAIM, OR (ii) THE TERMINATION OF YOUR ACCOUNT. IF YOU PAID NO PLATFORM FEES IN THAT WINDOW, GAM'S AGGREGATE LIABILITY IS ZERO.

FOR PURPOSES OF THIS SECTION, "**PLATFORM FEES**" MEANS FEES CHARGED BY GAM FOR USE OF THE PLATFORM, INCLUDING THE PER-OCCUPIED-UNIT PLATFORM FEE, THE PER-PROPERTY MINIMUM, THE SHORT-TERM-STAY AGGREGATE FEE, AND THE CONNECT ACCOUNT FEE. **PLATFORM FEES DO NOT INCLUDE, AND THE FOREGOING CAP EXCLUDES**:

- (i) PAYMENT PROCESSING FEES OF ANY KIND, WHETHER ACH OR CARD, REGARDLESS OF WHETHER THEY WERE PAID BY THE TENANT (PASS-THROUGH) OR THE LANDLORD;
- (ii) BANKING FEES, NETWORK INTERCHANGE, AND ANY THIRD-PARTY PAYMENT-NETWORK FEE OR SURCHARGE;
- (iii) FEES CHARGED BY ANY THIRD-PARTY SERVICE PROVIDER (INCLUDING STRIPE, PLAID, CHECKR, RESEND) FOR SERVICES THEY PROVIDE, EVEN WHEN INVOICED THROUGH GAM;
- (iv) ANY AMOUNT GAM COLLECTED ON BEHALF OF, OR PASSED THROUGH TO, A THIRD PARTY;
- (v) ANY AMOUNT TENDERED AS RENT, TENANT DEPOSIT, OR OTHER LANDLORD-DESTINED REVENUE.

**PROCESSING FEES, BANKING FEES, NETWORK FEES, AND THIRD-PARTY PASS-THROUGH AMOUNTS ARE NEVER RECOVERABLE FROM GAM** — NOT WITHIN THIS CAP, NOT IN ADDITION TO THIS CAP, AND NOT UNDER ANY THEORY OF LIABILITY.

THIS LIMITATION APPLIES IN THE AGGREGATE TO ALL CLAIMS AND IS NOT INCREASED BY MULTIPLE CLAIMS, MULTIPLE THEORIES OF LIABILITY, OR MULTIPLE INSTANCES OF HARM. THESE LIMITATIONS APPLY EVEN IF AN EXCLUSIVE REMEDY FAILS OF ITS ESSENTIAL PURPOSE. SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF INCIDENTAL OR CONSEQUENTIAL DAMAGES, SO PORTIONS OF THIS SECTION MAY NOT APPLY TO YOU.

## 17. Indemnification

You agree to defend, indemnify, and hold harmless GAM, its affiliates, and their respective officers, directors, employees, and agents from and against any and all claims, damages, obligations, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising from:

- Your access to or use of the Platform;
- Your User Content;
- Your violation of these Terms;
- Your violation of any applicable law, including without limitation the Fair Housing Act, the FCRA, state tenant-landlord law, tax law, and consumer protection law;
- Your violation of any third party's rights, including any intellectual property right or privacy right;
- Any dispute between you and a Tenant, Landlord, PM Company, manager, or other counterparty to a transaction or relationship facilitated by the Platform.

GAM reserves the right, at its own expense, to assume the exclusive defense and control of any matter subject to indemnification by you, in which case you agree to cooperate with GAM in the defense.

## 18. Termination

### 18.1 Termination by You

You may terminate your account at any time by closing it through the Platform's account-settings surface or by contacting `support@goldassetmanagement.com`. Termination does not relieve you of obligations accrued before termination, including outstanding payment obligations, indemnification, or the surviving terms set out in Section 21 below.

### 18.2 Termination by GAM

GAM may suspend or terminate your account, with or without notice, for any of the following:

- Material breach of these Terms;
- Suspected fraud, money laundering, or unlawful use of the Platform;
- Chargeback or ACH-return pattern;
- A direction from Stripe or any other third-party processor that we cease providing the Platform to you;
- Operational, security, or regulatory necessity;
- Sustained inactivity (no login for twenty-four (24) months).

Upon termination, your right to access the Platform ceases immediately. We may retain your data per the [Privacy Policy](./PRIVACY_POLICY.md) and applicable record-retention laws.

### 18.3 Effect on Existing Tenancies

If a Landlord's account is terminated, GAM may continue to process Tenant payments through the Payment Rail for a limited transition period to allow the Landlord to make alternate arrangements. We will use reasonable efforts to coordinate an orderly handoff but do not guarantee any specific transition timeline.

## 19. Dispute Resolution; Binding Arbitration; Class Action Waiver

**PLEASE READ THIS SECTION CAREFULLY. IT AFFECTS YOUR LEGAL RIGHTS, INCLUDING YOUR RIGHT TO BRING A CLAIM IN COURT AND TO PARTICIPATE IN A CLASS ACTION.**

### 19.1 Informal Resolution

Before initiating any formal dispute, you agree to first contact GAM at `support@goldassetmanagement.com` and provide a written description of the dispute, including the nature of the claim and the relief sought. GAM and you agree to attempt to resolve the dispute through good-faith negotiation for at least thirty (30) days from receipt of the notice.

### 19.2 Binding Arbitration

If the dispute is not resolved within thirty (30) days, you and GAM agree that any claim, controversy, or dispute arising out of or relating to these Terms or the Platform (a "**Dispute**") will be resolved exclusively through final and binding arbitration administered by the American Arbitration Association ("**AAA**") under its then-current Consumer Arbitration Rules. The arbitration will be conducted by a single arbitrator, in English, and the seat of arbitration will be in Wilmington, Delaware, unless the parties mutually agree to a different seat. The arbitrator may conduct the arbitration by telephone, videoconference, or in writing, and an in-person hearing will be held only at the parties' joint request or the arbitrator's order on good cause shown.

The arbitrator has exclusive authority to resolve any Dispute relating to the interpretation, applicability, enforceability, or formation of this arbitration agreement, including any claim that all or any part of this arbitration agreement is void or voidable.

The Federal Arbitration Act (9 U.S.C. §§ 1 et seq.) governs the interpretation and enforcement of this arbitration agreement. The arbitrator's award will be final and binding, and judgment on the award may be entered in any court of competent jurisdiction.

### 19.3 Class Action Waiver

**You and GAM agree that any Dispute will be resolved on an individual basis only. Neither you nor GAM will be entitled to join or consolidate Disputes by or against other Users, or to litigate any Dispute as a representative or member of a class, collective action, or private attorney general action.** The arbitrator may not consolidate more than one party's claims and may not preside over any form of representative or class proceeding.

If a court of competent jurisdiction determines that this class action waiver is unenforceable as to a particular claim or remedy, then that claim or remedy (and only that claim or remedy) will be severed from arbitration and brought in court, and the remainder of this Section 19 will remain in full force.

### 19.4 Carve-Outs

Notwithstanding the foregoing:

- Either party may bring an individual action in small-claims court for any Dispute within the small-claims court's jurisdictional limits;
- Either party may seek injunctive or other equitable relief in court to protect its intellectual property, confidential information, or trade secrets pending arbitration;
- The class action waiver in Section 19.3 cannot be severed by an arbitrator. If the class action waiver is found unenforceable, the entire arbitration agreement is unenforceable as to the affected claim, which will be brought in court.

### 19.5 Thirty-Day Opt-Out

You may opt out of the arbitration and class action waiver in this Section 19 by sending written notice of your decision to opt out to `support@goldassetmanagement.com` (with "Arbitration Opt-Out" in the subject line) within thirty (30) days of first agreeing to these Terms. Your opt-out notice must include your full legal name, account email, and a clear statement that you wish to opt out. If you opt out, the remainder of these Terms continues to apply.

## 20. Governing Law and Venue

These Terms are governed by the laws of the State of Delaware, without regard to its conflict-of-laws principles. Subject to Section 19 (Arbitration), the state and federal courts located in Wilmington, Delaware have exclusive jurisdiction over any Dispute not subject to arbitration, and you consent to the personal jurisdiction and venue of those courts.

## 21. Surviving Provisions

The following Sections survive termination of these Terms for any reason: Section 6 (Payment Processing, to the extent of accrued obligations), Section 8 (Refunds), Section 12 (User Content, license to retain residual copies), Section 13 (Intellectual Property), Section 15 (Disclaimers), Section 16 (Limitation of Liability), Section 17 (Indemnification), Section 19 (Dispute Resolution), Section 20 (Governing Law), and this Section 21.

## 22. Changes to These Terms

GAM may revise these Terms from time to time. We will notify you of material changes by email to the address on file and by in-platform notification at least thirty (30) days before the changes take effect, except where a shorter notice period is required by law, regulator direction, or security necessity. Your continued use of the Platform after the effective date of the change constitutes your acceptance of the revised Terms. If you do not agree to the revised Terms, your sole remedy is to close your account before the effective date.

We will maintain prior versions of these Terms for thirty-six (36) months after they are superseded.

## 23. General

### 23.1 Entire Agreement

These Terms, together with the [Privacy Policy](./PRIVACY_POLICY.md), the service-specific terms referenced in Section 1, and the Stripe Connect Services Agreement, constitute the entire agreement between you and GAM regarding the Platform and supersede all prior or contemporaneous communications.

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

Nothing in these Terms creates any agency, partnership, joint venture, employment, or fiduciary relationship between you and GAM.

---

## Contact

Questions about these Terms? Email `support@goldassetmanagement.com` or write to:

Gold Asset Management LLC
2843 East Frontage Road
Amado, AZ 85645
