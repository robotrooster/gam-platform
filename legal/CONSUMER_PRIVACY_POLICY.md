# Consumer Privacy Policy

**Gold Asset Management**
2843 East Frontage Road, Amado, AZ 85645
Effective Date: [DATE OF PUBLIC LAUNCH]
Last Updated: [DATE]

---

> **WHO THIS APPLIES TO.** This Consumer Privacy Policy
> describes how GAM collects, uses, shares, and protects
> personal information of Tenants and prospective Tenants
> (rental applicants) using the GAM platform.
>
> If you are a Landlord, PM Company, or staff member
> operating under one of those, see the
> [Business Privacy Policy](./BUSINESS_PRIVACY_POLICY.md)
> instead.

---

## 1. Introduction

This Privacy Policy explains how **Gold Asset Management LLC** ("**GAM**," "**we**," "**us**," "**our**") collects, uses, shares, and protects personal information when you use the GAM platform as a Tenant — including our tenant portal, mobile-responsive surfaces, and related services we operate under the Gold Asset Management brand (collectively, the "**Platform**").

This Privacy Policy is part of, and incorporated by reference into, the [Consumer Terms of Service](./CONSUMER_TERMS_OF_SERVICE.md). Capitalized terms not defined here have the meaning given in the Consumer Terms of Service.

If you do not agree to this Privacy Policy, do not use the Platform.

## 2. Information We Collect From You

We collect personal information from three sources: (a) directly from you when you provide it; (b) automatically when you use the Platform; and (c) from third parties who provide it to us with your consent or as authorized by law.

### 2.1 Information You Provide

**Account information**: name, email address, phone number, password (stored only as a one-way bcrypt hash), preferred communication settings, time zone, and date of birth.

**Identity verification information** (collected when required to enable payment-method features or other regulated functions): legal name, residential address, government-issued identification number where applicable, photo identification document, and selfie verification (collected by Stripe Identity on our behalf).

**Lease and tenancy information**: the lease document you sign with your Landlord, lease start and end dates, monthly rent, security deposit amount, signed addenda, and e-signature records. Your Landlord provides their portion of this information; you provide your acceptance and signature.

**Payment information**: bank account number and routing number (for ACH onboarding via Plaid or Stripe Financial Connections; account numbers are encrypted at rest and we retain only the last four digits in unencrypted form), card information (handled by Stripe Elements; GAM does not store full card numbers), and payment-method metadata.

**Rental application and screening information** (when you apply to a property listed on the Platform): your application, your FCRA-compliant authorization for the screening provider to run a consumer report on you, the resulting consumer report (credit summary, eviction history, criminal background, identity verification) sent by the screening provider, and any adverse-action notice GAM delivers to you on your Landlord's behalf if the application is declined based in whole or in part on the consumer report.

**FlexSuite enrollment information** (when you enroll in a FlexSuite product). The data GAM collects differs by product based on whether GAM, the Landlord, or a third-party lender is the creditor — see Consumer Terms of Service § 9 for the structure of each product.

- **FlexDeposit** (Service-Level Agreement; not credit): your FlexDeposit Service-Level Agreement with GAM; the schedule of service-fee installments; ACH-pull authorization for the scheduled installments; payment history under the SLA, used by GAM internally for service-tier decisions only and **not furnished to any consumer reporting agency**. FlexDeposit eligibility is determined from your existing Platform account data (e.g., your tenancy record, payment history on the Platform, and active-lease status). FlexDeposit eligibility is not a credit decision and does not involve any consumer report obtained from a third-party consumer reporting agency.
- **FlexPay** (payment-date scheduling subscription; no credit extension): the Scheduled Pull Date you select (a calendar day from the 1st through the 28th); the calculated monthly subscription fee under the date-based formula in Consumer ToS § 9.2; the payment-date schedule you choose for your rent and other recurring charges; ACH-pull authorization for the FlexPay monthly subscription fee; subscription billing history. GAM does not advance any funds on your behalf for FlexPay; no payment-performance data is furnished to any consumer reporting agency from FlexPay.
- **FlexCharge** (Business Account Owner is the creditor; GAM provides accounting): the FlexCharge Business Account Agreement signed between you and the Business Account Owner (your Landlord, or a separate POS operator) at the specific Location where FlexCharge is enabled; transaction history (each charge posted by the Business Account Owner and each payment you make against the balance); the running balance; payment-receipt records. **GAM does not collect or process credit-underwriting data for FlexCharge** — the credit decision and the credit-limit setting are made by the Business Account Owner, and any underwriting-related data is held by the Business Account Owner, not by GAM.
- **FlexCredit** (third-party FlexCredit Lender is the creditor; GAM is a referral partner): the application you submit, which GAM passes to the FlexCredit Lender; the FlexCredit Lender's decision; the resulting payment-flow integration into your tenant account (e.g., scheduled deductions to repay the FlexCredit Lender, if applicable). **GAM does not perform credit underwriting on FlexCredit applications** — the FlexCredit Lender makes the credit decision and holds the substantive underwriting data. The FlexCredit Lender's privacy policy governs the FlexCredit Lender's separate processing of your information; it is disclosed to you at the time of FlexCredit enrollment.

**Communications**: in-platform messages with your Landlord, your Property Manager, GAM support, and where applicable PM Company staff; support emails sent to `support@goldassetmanagement.com`; survey responses; notification preferences; comments on inspections, entry requests, and maintenance tickets.

**Maintenance and inspection information**: photos and descriptions you upload for maintenance tickets you submit; responses to inspection requests for your unit.

**Disputes and habitability reports**: dispute information you submit through the Platform's tenant dispute surface; habitability concerns you raise.

### 2.2 Information We Collect Automatically

**Device and usage information**: IP address, browser type and version, operating system, device identifiers, referring URL, pages visited, features used, and timestamps. This information is collected through server logs and session telemetry.

**Cookies and similar technologies**: we use first-party session cookies to authenticate your session and remember your preferences. We do **not** use third-party advertising or cross-site tracking cookies. We do not participate in real-time bidding, retargeting networks, or behavioral advertising.

**Error and performance telemetry**: we use Sentry to capture uncaught application errors and server exceptions. Sentry events include the stack trace, the URL of the page where the error occurred, browser information, and a generated request ID. We have configured Sentry to **not** send personal information (no user emails, no IP addresses, no request bodies) by default.

### 2.3 Information From Third Parties

**Identity verification**: Stripe Identity returns verification status, ID document metadata, and selfie match results when you complete a verification flow.

**Bank verification**: Plaid or Stripe Financial Connections returns bank account ownership data, account balance (snapshot only, not ongoing), and ACH eligibility status when you link a bank account.

**Tenant screening**: the screening provider (Checkr, when active) returns a consumer report under FCRA when you authorize screening through a Landlord-initiated application.

**Payment processor data**: Stripe returns transaction status, ACH return notifications, and chargeback notifications.

**FlexSuite credit-history data** (if applicable to a specific FlexSuite product at enrollment time): consumer credit information from the credit-reporting partner identified in the product-specific disclosures, where the underwriting of the product requires it.

## 3. How We Use Your Information

We use personal information for the following purposes:

- **To provide the Platform's tenant features**: enable account creation; authenticate sessions; deliver your lease document; collect rent and other charges; surface payment receipts; deliver maintenance and inspection workflows; render your tenant dashboard.
- **To process payments**: route your rent payment through Stripe to your Landlord's Connect balance; calculate any pass-through processing fees; charge FlexSuite subscription fees where you have enrolled; reconcile any chargebacks or ACH returns.
- **To verify your identity for regulated features**: complete KYC verification via Stripe Identity where required; verify bank account ownership via Plaid or Stripe Financial Connections; comply with anti-money-laundering and sanctions-screening requirements.
- **To run tenant screening you have authorized**: order a consumer report from the screening provider with your FCRA-compliant authorization; deliver an adverse-action notice on your Landlord's behalf if the application is declined based in whole or in part on the report.
- **To facilitate your enrollment in FlexSuite products**: deliver the product-specific disclosures; verify eligibility; process repayments or subscription fees per the product-specific terms.
- **To communicate with you**: send transactional emails (registration confirmation, password reset, rent receipts, payment-failure notifications, maintenance updates, dispute responses, FlexSuite enrollment confirmations); respond to support inquiries.
- **To detect and prevent fraud, abuse, and security incidents**: review login patterns; rate-limit authentication attempts; investigate disputes; respond to security alerts.
- **To improve the Platform**: analyze aggregate usage patterns; debug errors via Sentry; refine product features.
- **To comply with legal obligations**: respond to subpoenas, court orders, and regulatory requests; maintain records required by law (including FCRA's retention requirements for screening-related records).

We do **not** use your personal information for behavioral advertising, profiling for marketing purposes, or training of artificial intelligence or machine learning models for external use. Internal model training, if any, is limited to anonymized, aggregated metrics — and as of this Privacy Policy's effective date, GAM does not train models on user data.

## 4. How We Share Your Information

We share personal information only as described below. We do **not** sell your personal information to third parties for any purpose.

### 4.1 With Your Landlord and Their Authorized Staff

Your tenancy is multi-party by design. The following information about you is visible to your Landlord and to the staff your Landlord has authorized:

- Your name, contact information, and the lease document signed between you and your Landlord;
- Your rent payment history (paid, pending, late, returned);
- Your screening report results (where you authorized screening as part of a rental application);
- Your maintenance ticket history;
- Your dispute submissions;
- Communications you have sent to your Landlord through the Platform.

Where your unit is managed by a PM Company, the PM Company's staff has comparable visibility.

### 4.2 With Service Providers

We share personal information with third-party service providers who process it on our behalf to enable the Platform. Each service provider is contractually bound to use the information only for the purpose for which we engaged them. Current service providers include:

- **Stripe, Inc.** — payment processing, Identity verification (where applicable), Financial Connections bank verification.
- **Resend, Inc.** — transactional email delivery.
- **Plaid Inc.** — bank account verification for ACH onboarding (in some regions and use cases).
- **The screening provider** identified at the time you authorize tenant screening (Checkr, when active). The screening provider is engaged solely for the Landlord-initiated rental-application screening described in Section 2.1 above. The screening provider has no role in any other Platform feature.
- **The collections partner** that your Landlord may engage for landlord-owed unpaid rent, as disclosed at the time the partner is engaged. The collections partner pursues unpaid rent under the Fair Debt Collection Practices Act and applicable state debt-collection law. The collections partner has no role in any other Platform feature.
- **The FlexCredit Lender**, identified at the time you apply for FlexCredit. The FlexCredit Lender is the creditor on FlexCredit (not GAM, not your Landlord); GAM transmits your application data to the FlexCredit Lender and receives the FlexCredit Lender's decision back. The FlexCredit Lender's own privacy policy governs how the FlexCredit Lender processes your information separately from this Privacy Policy.
- **Functional Software, Inc. d/b/a Sentry** — application error tracking.
- The hosting and database provider that hosts the Platform's infrastructure.

Your **Landlord** is the creditor on FlexCharge and is also disclosed under Section 4.1 (other Users of the Platform), not under this service-provider list — the Landlord is your counterparty, not GAM's vendor. **FlexPay** is operated by GAM directly and does not involve an external FlexSuite product partner.

We may add, remove, or substitute service providers from time to time. The list above reflects our current set as of the effective date of this Privacy Policy.

### 4.3 As Required by Law

We may disclose personal information when we believe in good faith that disclosure is required by:

- A subpoena, court order, or other valid legal process;
- A request from a law enforcement authority, regulator, or government agency with jurisdiction over us;
- A legal obligation under applicable consumer-protection, fair-credit-reporting, or anti-money-laundering law;
- The need to enforce the Terms or protect the rights, property, or safety of GAM, our Users, or the public.

Where legally permitted, we will notify you before disclosing your information in response to a legal demand.

### 4.4 In Connection With a Business Transaction

If GAM is acquired, merges with another entity, sells substantially all of its assets, or undergoes a similar corporate transaction (including bankruptcy or assignment for the benefit of creditors), your personal information may be transferred to the acquiring entity as part of the transaction, subject to the terms of this Privacy Policy or a successor policy that provides equivalent protection. We will notify you of any such transfer where required by law.

### 4.5 With Your Consent

We may share personal information for other purposes when you direct us to do so or otherwise consent.

## 5. Data Retention

**GAM retains tenant personal information for the duration of operational, regulatory, fraud-detection, and dispute-defense need.** Financial transaction records, lease history, payment history, screening reports (subject to FCRA retention rules), identity-verification documentation, communications, maintenance and inspection records, audit logs, and security telemetry have ongoing value beyond the duration of any individual tenancy. We retain personal information for the period reasonably necessary to fulfill the purposes for which we collected it, and as required by applicable law.

**Your right to request deletion.** Under several state privacy laws (including California's CCPA/CPRA), you have the right to request deletion of personal information GAM has collected from you. Each of those laws also grants the business statutory exceptions that permit continued retention for purposes including: completing the transaction for which the information was collected, providing the goods or services you requested, detecting security incidents, identifying and preventing fraud, complying with legal obligations (including FCRA retention rules), exercising or defending legal claims, and other narrowly-defined purposes.

When you submit a deletion request, GAM will:

- Evaluate the request against each statutory exception applicable under your state's privacy law;
- Delete personal information that does not qualify for retention under any applicable exception;
- Retain personal information that does qualify (which may include most categories that are still being actively used to provide the service, complete the transaction, comply with FCRA retention requirements, or defend potential claims);
- Send you a response describing what was deleted and what was retained, with the statutory basis for retention.

If you have closed your account and your tenancy has ended, deletion qualifies for more categories. Where a federal or state law mandates a *minimum* retention period (for example, FCRA's retention rules for consumer reports and adverse-action notices), GAM retains at least for that period.

**Backup snapshots.** Operational disaster-recovery snapshots are retained on a rolling ninety (90) day window. When personal information is deleted from primary storage, the deletion propagates to backup snapshots on the next applicable backup cycle.

## 6. Data Security

We use commercially reasonable administrative, technical, and physical safeguards to protect your personal information. These include:

- TLS encryption for all data in transit between your device and the Platform;
- Encryption at rest for sensitive fields, including bank account numbers (encrypted at the column level with rotating keys) and password hashes (one-way bcrypt with cost factor tuned to current best practice);
- Card data is handled by Stripe and tokenized; GAM does not store full card numbers;
- Two-factor authentication available for your account;
- Per-account login lockout after five failed attempts within fifteen minutes; tighter rate-limiting on the login endpoint to defend against credential-stuffing;
- Application monitoring via Sentry; structured logging for forensic traceability;
- Regular review of access permissions and authentication logs.

No system is impenetrable. **In the event of a data breach affecting your information, we will notify you and applicable regulators consistent with the breach-notification laws of your state of residence.**

## 7. Your Privacy Rights

### 7.1 Rights Available to All Tenants

You may, at any time:

- **Access** the personal information we hold about you. Many surfaces are visible directly within the Platform; for information not surfaced in-product, email `support@goldassetmanagement.com` with a request.
- **Correct** inaccurate or incomplete personal information through your account profile or by emailing us.
- **Close your account.** See Section 5 above for what happens to your data when you close your account.
- **Submit a deletion request** under a state privacy law that grants you that right. See Section 5 above for how deletion requests are evaluated.
- **Export** a copy of your personal information in a structured, commonly used format.
- **Opt out of marketing email**. We do not currently send marketing email; if we begin to do so, opt-out links will be included in each such message. Transactional emails (rent receipts, payment notifications, maintenance updates, etc.) related to your active tenancy are not subject to opt-out.
- **Dispute the contents of a consumer report obtained about you through the Platform's screening flow.** Under FCRA, you have the right to dispute the report directly with the screening provider that issued it. GAM is not the consumer reporting agency; the screening provider is.

To exercise these rights, email `support@goldassetmanagement.com` with a description of the request. We may need to verify your identity before we can act on the request. We will respond within thirty (30) days, or, where the law of your state requires a shorter response window, within that window.

### 7.2 Rights for California Residents (CCPA / CPRA)

If you are a California resident, you have additional rights under the California Consumer Privacy Act, as amended by the California Privacy Rights Act:

- **Right to know** the categories and specific pieces of personal information we have collected about you, the sources from which we collected it, the purposes for which we collected it, and the categories of third parties with whom we shared it. The disclosures in Sections 2, 3, and 4 above describe our practices in the aggregate; you may submit a verifiable request for the specific information we hold about you.
- **Right to delete** personal information we have collected from you, subject to statutory exceptions (see Section 5).
- **Right to correct** inaccurate personal information.
- **Right to opt out of sale or sharing** of personal information. **We do not sell or share personal information as those terms are defined under California law.**
- **Right to limit use of sensitive personal information**. The sensitive personal information we collect (Social Security Number for KYC where required, government ID for verification, financial account numbers, precise geolocation if any) is used only for the purpose of providing the Platform and complying with legal obligations.
- **Right to non-discrimination** for exercising these rights.

We do not knowingly collect personal information from minors under sixteen (16) and do not sell or share personal information of minors.

To submit a CCPA/CPRA request, email `support@goldassetmanagement.com` with "California Privacy Request" in the subject line.

### 7.3 Rights for Other State Residents

We also recognize the rights granted by the privacy laws of Virginia (VCDPA), Colorado (CPA), Connecticut (CTDPA), Utah (UCPA), Texas (TDPSA), Oregon (OCPA), Montana, Iowa, Tennessee, Indiana, and Delaware. Residents of those states have rights substantially similar to those listed above. To exercise them, follow the same process — email `support@goldassetmanagement.com` with a description of your request.

### 7.4 Appeals

If we decline a request, you may appeal the decision by emailing `support@goldassetmanagement.com` with "Privacy Appeal" in the subject line. We will respond to the appeal within forty-five (45) days, or within a shorter period if required by the law of your state. If we deny the appeal, you may contact your state's Attorney General's office to file a complaint.

## 8. Children's Privacy

The Platform is not directed to children under eighteen (18) and is not intended for use by anyone under eighteen. We do not knowingly collect personal information from children under thirteen (13) in violation of the Children's Online Privacy Protection Act ("**COPPA**").

If we learn that we have collected personal information from a child under thirteen, we will delete it promptly. If you believe a child under thirteen has provided us with personal information, contact `support@goldassetmanagement.com`.

## 9. International Users

The Platform is operated from the United States and is intended for use by Users located in the United States. Personal information is stored and processed in the United States. If you access the Platform from outside the United States, you understand that your information will be transferred to and processed in the United States, which may have data-protection laws that differ from those of your jurisdiction.

GAM does not currently offer the Platform in the European Economic Area, the United Kingdom, Switzerland, or other jurisdictions covered by the General Data Protection Regulation.

## 10. Third-Party Links and Services

The Platform may link to or integrate with third-party websites and services that operate under their own privacy policies (e.g., the Stripe Connect-hosted onboarding pages, Plaid's bank-link interface, the screening provider's interface, the FlexSuite product partner interfaces). We are not responsible for the privacy practices of those third parties. Review the relevant third party's privacy policy before providing personal information through their surfaces.

## 11. Do-Not-Track Signals

Some browsers offer a "Do Not Track" ("DNT") signal. The Platform does not respond to DNT signals because we do not engage in cross-site tracking or behavioral advertising for which DNT was designed. We do honor the "Opt Out of Sale or Sharing" signals (e.g., the Global Privacy Control header, where the signal indicates the request originates from California or another applicable state) for jurisdictions that legally require us to do so.

## 12. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. The "Last Updated" date at the top reflects when the most recent changes took effect. For material changes, we will notify you by email to the address on file and by in-platform notification at least thirty (30) days before the changes take effect, except where a shorter notice period is required by law or security necessity.

We will maintain prior versions of this Privacy Policy for thirty-six (36) months after they are superseded.

## 13. Contact

Questions, requests, complaints, or feedback regarding this Privacy Policy? Email `support@goldassetmanagement.com` or write to:

Gold Asset Management LLC
Attn: Privacy
2843 East Frontage Road
Amado, AZ 85645

For state-specific privacy requests, please include the relevant state law in your subject line (e.g., "California Privacy Request," "Virginia Privacy Request") so we can route the request promptly.

---

## Appendix A — Categories of Personal Information Under CCPA/CPRA

For purposes of California's CCPA/CPRA, the following categories of personal information are collected from tenant users in the prior twelve (12) months, the purposes for which collected, and the categories of third parties to whom disclosed (for business purposes; not for sale).

| Category (per CCPA § 1798.140) | Examples | Collected? | Disclosed for a business purpose? | Sold or shared? |
|---|---|---|---|---|
| A. Identifiers | name, email, phone, IP address | Yes | Yes — Stripe, Resend, Sentry, hosting provider | No |
| B. Personal information categories under Cal. Civ. Code § 1798.80 | name, address, phone, financial account information | Yes | Yes — Stripe, Plaid, screening provider, FlexSuite partner | No |
| C. Protected classification characteristics | date of birth, marital status (only when collected for screening) | Yes — when required | Yes — screening provider, Stripe Identity | No |
| D. Commercial information | rent payment history, fees paid, FlexSuite enrollment | Yes | Yes — Stripe, FlexSuite partner, hosting provider | No |
| E. Biometric information | selfie/face match during Stripe Identity verification (collected by Stripe, not stored by GAM) | No (Stripe collects directly) | N/A | No |
| F. Internet or other network activity | browsing history within the Platform, session telemetry | Yes | Yes — hosting provider, Sentry | No |
| G. Geolocation data | approximate location inferred from IP address | Yes (approximate only) | Yes — hosting provider | No |
| H. Audio, electronic, visual information | photos uploaded for maintenance tickets, lease documents | Yes | Yes — hosting provider | No |
| I. Professional or employment-related information | employment information when required for screening | Yes — when required | Yes — screening provider | No |
| J. Education information | Not collected | No | N/A | N/A |
| K. Inferences | None drawn for marketing or profiling purposes | No | N/A | N/A |
| L. Sensitive personal information | Social Security Number / ITIN (where required for screening or KYC), government ID, financial account numbers | Yes — when required | Yes — Stripe Identity, Plaid, screening provider (only for the regulated purpose) | No |

We retain each category of personal information for the period described in Section 5.
