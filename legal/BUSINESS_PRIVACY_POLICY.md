# Business Privacy Policy

**Gold Asset Management**
2843 East Frontage Road, Amado, AZ 85645
Effective Date: [DATE OF PUBLIC LAUNCH]
Last Updated: [DATE]

---

> **WHO THIS APPLIES TO.** This Business Privacy Policy
> describes how GAM collects, uses, shares, and protects
> personal information of business users — Landlords,
> PM Companies, and the staff or contractors operating under
> them (Property Managers, on-site managers, maintenance
> workers, bookkeepers, and other ancillary roles).
>
> If you are a Tenant, see the
> [Consumer Privacy Policy](./CONSUMER_PRIVACY_POLICY.md)
> instead.

---

## 1. Introduction

This Privacy Policy explains how **Gold Asset Management LLC** ("**GAM**," "**we**," "**us**," "**our**") collects, uses, shares, and protects personal information when you use the GAM platform as a business user — including our websites, business portals (landlord, admin-ops, PM company, property intelligence, listings, marketing, GAM Books, and POS), APIs, and related services (collectively, the "**Platform**").

This Privacy Policy is part of, and incorporated by reference into, the [Business Terms of Service](./BUSINESS_TERMS_OF_SERVICE.md). Capitalized terms not defined here have the meaning given in the Business Terms of Service.

If you do not agree to this Privacy Policy, do not use the Platform.

## 2. Information We Collect From Business Users

We collect personal information from three sources: (a) directly from you when you provide it; (b) automatically when you use the Platform; and (c) from third parties who provide it to us with your consent or as authorized by law.

### 2.1 Information You Provide

**Account information**: name, email address, phone number, password (stored only as a one-way bcrypt hash), preferred communication settings, time zone, and account role.

**Identity verification information** (collected when required to enable money movement or other regulated features): legal name, date of birth, residential address, government-issued identification number (Social Security Number or Individual Taxpayer Identification Number where required), photo identification document, and selfie verification (collected by Stripe Identity on our behalf).

**Property and business information**: property addresses, ownership documentation, business entity information (legal name, state of formation, EIN), beneficial-owner information for Stripe Connect onboarding, and operational settings.

**Lease and tenancy information you submit about your tenants**: lease terms, monthly rent, security deposit, move-in date, move-out date, late-fee configuration, lease document, signed addenda, and e-signature records. (Tenant-side identifying information you submit is governed by your own obligations to your tenants under applicable law.)

**Payment information**: bank account number and routing number (for Connect-account funding via Plaid or Stripe Financial Connections; account numbers are encrypted at rest and we retain only the last four digits in unencrypted form), Stripe Connect account ID, payout configuration, and payment-method metadata.

**Tenant-screening information you initiate** (when you request screening through the Platform): the prospective Tenant's consents, the screening provider's response, and the surfaced consumer report. You are responsible for FCRA compliance in your handling of these reports.

**Communications**: in-platform messages with Tenants, PM Companies, sub-users, and GAM support; support emails sent to `support@goldassetmanagement.com`; survey responses; notification preferences; comments on inspections, entry requests, and maintenance tickets.

**Maintenance and inspection information**: photos, descriptions, and resolution notes for maintenance tickets and property inspections under your properties.

**Tax, payroll, and bookkeeping information** (GAM Books users): payroll information for property employees (wages, hours, deductions); 1099-NEC contractor payments; chart-of-accounts data; manual journal entries.

**On-Time Pay reporting enrollment information** (when you enroll a Tenant): the Tenant's identifying information necessary to report on-time rent payments to the applicable consumer reporting agency, the enrollment cadence, and your authorization to fund the reporting fee on the Tenant's behalf.

### 2.2 Information We Collect Automatically

**Device and usage information**: IP address, browser type and version, operating system, device identifiers, referring URL, pages visited, features used, and timestamps. This information is collected through server logs and session telemetry.

**Cookies and similar technologies**: we use first-party session cookies to authenticate your session and remember your preferences. We do **not** use third-party advertising or cross-site tracking cookies. We do not participate in real-time bidding, retargeting networks, or behavioral advertising.

**Error and performance telemetry**: we use Sentry to capture uncaught application errors and server exceptions. Sentry events include the stack trace, the URL of the page where the error occurred, browser information, and a generated request ID. We have configured Sentry to **not** send personal information (no user emails, no IP addresses, no request bodies) by default; we filter expected 4xx client errors and capture only 5xx and uncaught exceptions.

### 2.3 Information From Third Parties

**Identity verification**: Stripe Identity returns verification status, ID document metadata, and selfie match results when you complete the Connect onboarding flow.

**Bank verification**: Plaid or Stripe Financial Connections returns bank account ownership data, account balance (snapshot only, not ongoing), and ACH eligibility status when you link a bank account.

**Background and credit reporting on tenants you screen**: the screening provider (Checkr, when active) returns consumer reports under FCRA when a Tenant authorizes screening through your Landlord-initiated application.

**Payment processor data**: Stripe returns transaction status, payout history, dispute history, and chargeback notifications.

**Public records and third-party data sources** (Property Intelligence feature only): we aggregate property parcel data from county GIS databases for the Property Intelligence portal. This data is publicly accessible and is not associated with your account unless you have manually linked a parcel to a Property in your portfolio.

## 3. How We Use Business-User Information

We use personal information for the following purposes:

- **To provide the Platform's business surfaces**: enable account creation; authenticate sessions; configure properties; collect rent; process payouts to your Connect balance; calculate Platform fees; run the deposit-return flow; deliver maintenance and inspection workflows; render dashboard surfaces.
- **To process payments and money movement**: route inbound tenant rent through the Payment Rail; settle outbound payouts to your Connect balance; reconcile chargebacks and ACH returns; deduct GAM fees.
- **To verify identity and authorize money movement**: complete KYC verification via Stripe Identity before activating your Connect account; verify bank account ownership via Plaid or Stripe Financial Connections; comply with anti-money-laundering and sanctions-screening requirements.
- **To run tenant screening you initiate**: order consumer reports from the screening provider; deliver adverse-action notices when required by FCRA; surface report results to you as the requesting Landlord.
- **To facilitate On-Time Pay reporting**: when you enroll a Tenant in OTP, transmit the on-time payment data to the applicable consumer reporting agency on the Tenant's behalf; charge the OTP fee to your account on the Tenant's behalf.
- **To communicate with you**: send transactional emails (registration confirmation, password reset, payout notifications, dispute notifications, OTP enrollment confirmations); send service announcements; respond to support inquiries.
- **To surface state-specific compliance information**: display state deposit interest rates, state tax form deadlines, and other state-specific data applicable to your properties' states.
- **To detect and prevent fraud, abuse, and security incidents**: review login patterns; rate-limit authentication attempts; investigate chargebacks; respond to security alerts.
- **To improve the Platform**: analyze aggregate usage patterns; debug errors via Sentry; refine product features.
- **To comply with legal obligations**: respond to subpoenas, court orders, and regulatory requests; facilitate tax reporting (e.g., 1099-K issuance via Stripe); maintain records required by law.

We do **not** use personal information for behavioral advertising, profiling for marketing purposes, or training of artificial intelligence or machine learning models for external use. Internal model training, if any, is limited to anonymized, aggregated metrics — and as of this Privacy Policy's effective date, GAM does not train models on user data.

## 4. How We Share Business-User Information

We share personal information only as described below. We do **not** sell personal information to third parties for any purpose.

### 4.1 With Other Users of the Platform

The Platform is multi-party by design. Some of your information is visible to other Users:

- **Tenants you onboard** can see your Landlord or PM Company contact information, lease documents, payment receipts, and maintenance ticket history for their tenancy.
- **PM Companies you contract with** can see Landlord and property information for the properties they manage.
- **Sub-users you invite** (Property Managers, maintenance workers, on-site managers, bookkeepers) see only the information their assigned scope permits.

The Platform's audit trail logs material actions taken by sub-users and is visible to the Landlord or PM Company that authorized them.

### 4.2 With Service Providers

We share personal information with third-party service providers who process it on our behalf to enable the Platform. Each service provider is contractually bound to use the information only for the purpose for which we engaged them and to protect it consistent with applicable law. Current service providers include:

- **Stripe, Inc.** — payment processing, Connect onboarding (Express), Identity verification, Radar fraud screening, Financial Connections bank verification.
- **Resend, Inc.** — transactional email delivery.
- **Plaid Inc.** — bank account verification for ACH onboarding (in some regions and use cases).
- **Checkr, Inc.** (when activated) — tenant screening and background checks.
- **The OTP reporting partner** — the consumer reporting agency that receives on-time-rent payment data for OTP-enrolled Tenants (identified at the time of OTP activation).
- **Functional Software, Inc. d/b/a Sentry** — application error tracking.
- The hosting and database provider that hosts the Platform's infrastructure.

We may add, remove, or substitute service providers from time to time. The list above reflects our current set as of the effective date of this Privacy Policy.

### 4.3 As Required by Law

We may disclose personal information when we believe in good faith that disclosure is required by:

- A subpoena, court order, or other valid legal process;
- A request from a law enforcement authority, regulator, or government agency with jurisdiction over us;
- A legal obligation under applicable tax, anti-money-laundering, or consumer-protection law (including issuance of 1099 forms by Stripe);
- The need to enforce the Terms or protect the rights, property, or safety of GAM, our Users, or the public.

Where legally permitted, we will notify affected Users before disclosing their information in response to a legal demand.

### 4.4 In Connection With a Business Transaction

If GAM is acquired, merges with another entity, sells substantially all of its assets, or undergoes a similar corporate transaction (including bankruptcy or assignment for the benefit of creditors), personal information may be transferred to the acquiring entity as part of the transaction, subject to the terms of this Privacy Policy or a successor policy that provides equivalent protection. We will notify affected Users of any such transfer where required by law.

### 4.5 With Your Consent

We may share personal information for other purposes when you direct us to do so or otherwise consent.

## 5. Data Retention

This retention policy applies to all business-user data — Landlords, PM Companies, their staff, and ancillary roles.

**GAM retains business-user personal information indefinitely.** GAM does not impose a routine deletion schedule, expiration period, or automatic purge against any category of personal information. Financial transaction records, property records, lease history, payment history, screening reports you ordered, identity-verification documentation, communications, maintenance and inspection records, audit logs, and security telemetry all have ongoing operational, fraud-detection, regulatory, dispute-defense, and litigation-preparedness value that persists indefinitely beyond the duration of any individual tenancy, transaction, or account. We intend to retain personal information for the full lifetime of GAM's operations.

**GAM deletes business-user personal information only when legally compelled to do so.** A User's right under state privacy law to *request* deletion is not the same as a legal mandate that GAM *perform* deletion; the privacy laws of every state that grants a deletion right also grant the business broad statutory exceptions that permit continued retention. **GAM applies each available statutory exception to the maximum extent permitted by law.** As a result, deletion occurs only in narrow circumstances (court order, regulator order, affirmative non-waivable statutory requirement, or a verifiable consumer deletion request submitted under a state privacy law where, after applying every available exception, no retention basis remains).

Where a federal or state law mandates a *minimum* retention period (for example, the Fair Credit Reporting Act's retention rules for consumer reports, or IRS recordkeeping rules for financial transactions), GAM retains at least for that period and continues to retain indefinitely thereafter under the default policy above.

**Backup snapshots.** Operational disaster-recovery snapshots are retained on a rolling ninety (90) day window. When personal information is deleted from primary storage under one of the legal-compulsion triggers above, the deletion propagates to backup snapshots on the next applicable backup cycle.

## 6. Data Security

We use commercially reasonable administrative, technical, and physical safeguards to protect personal information. These include:

- TLS encryption for all data in transit between your device and the Platform;
- Encryption at rest for sensitive fields, including bank account numbers (encrypted at the column level with rotating keys) and password hashes (one-way bcrypt with cost factor tuned to current best practice);
- Card data is handled by Stripe and tokenized; GAM does not store full card numbers;
- Two-factor authentication required for all administrative and super-administrative accounts and optional for Landlord, PM Company, and sub-user accounts;
- Role-based access controls limit sub-user access to only the units, properties, or features they have been scoped to;
- Per-account login lockout after five failed attempts within fifteen minutes; tighter rate-limiting on the login endpoint to defend against credential-stuffing;
- Application monitoring via Sentry; structured logging for forensic traceability;
- Regular review of access permissions and authentication logs.

No system is impenetrable. **In the event of a data breach affecting your information, we will notify you and applicable regulators consistent with the breach-notification laws of your state of residence.**

## 7. Your Privacy Rights

### 7.1 Rights Available to All Business Users

You may, at any time:

- **Access** the personal information we hold about you. Many surfaces are visible directly within the Platform; for information not surfaced in-product, email `support@goldassetmanagement.com` with a request.
- **Correct** inaccurate or incomplete personal information through your account profile or by emailing us.
- **Close your account.** Closing your account ends your access to the Platform but, as described in Section 5, **does not by itself trigger deletion of the personal information already collected.**
- **Submit a deletion request** under a state privacy law that grants you that right. Deletion requests are evaluated against the statutory exceptions available to GAM under the applicable law and against the retention policy in Section 5.
- **Export** a copy of your personal information in a structured, commonly used format.
- **Opt out of marketing email**. Note that we do not currently send marketing email; if we begin to do so, opt-out links will be included in each such message. Transactional emails (related to your account and active transactions) are not subject to opt-out.

To exercise these rights, email `support@goldassetmanagement.com` with a description of the request. We may need to verify your identity before we can act on the request. We will respond within thirty (30) days, or, where the law of your state requires a shorter response window, within that window.

### 7.2 Rights for California Residents (CCPA / CPRA)

If you are a California resident operating a sole proprietorship or other natural-person business, you have rights under the California Consumer Privacy Act, as amended by the California Privacy Rights Act, to: know the categories and specific pieces of personal information we have collected about you; delete personal information subject to statutory exceptions; correct inaccurate personal information; opt out of sale or sharing (**we do not sell or share personal information**); limit use of sensitive personal information; and non-discrimination for exercising these rights.

To submit a CCPA/CPRA request, email `support@goldassetmanagement.com` with "California Privacy Request" in the subject line.

### 7.3 Rights for Other State Residents

We also recognize the rights granted by the privacy laws of Virginia (VCDPA), Colorado (CPA), Connecticut (CTDPA), Utah (UCPA), Texas (TDPSA), Oregon (OCPA), Montana, Iowa, Tennessee, Indiana, and Delaware. Residents of those states have rights substantially similar to those listed above. To exercise them, follow the same process — email `support@goldassetmanagement.com` with a description of your request.

### 7.4 Appeals

If we decline a request, you may appeal the decision by emailing `support@goldassetmanagement.com` with "Privacy Appeal" in the subject line. We will respond to the appeal within forty-five (45) days. If we deny the appeal, you may contact your state's Attorney General's office to file a complaint.

## 8. Children's Privacy

The Platform is not directed to children under eighteen (18) and is not intended for use by anyone under eighteen. We do not knowingly collect personal information from children under thirteen (13) in violation of the Children's Online Privacy Protection Act ("COPPA").

## 9. International Users

The Platform is operated from the United States and is intended for use by Users located in the United States. Personal information is stored and processed in the United States.

GAM does not currently offer the Platform in the European Economic Area, the United Kingdom, Switzerland, or other jurisdictions covered by the General Data Protection Regulation.

## 10. Third-Party Links and Services

The Platform may link to or integrate with third-party websites and services that operate under their own privacy policies (e.g., the Stripe Connect-hosted onboarding pages, Plaid's bank-link interface, Checkr's screening interface). We are not responsible for the privacy practices of those third parties. Review the relevant third party's privacy policy before providing personal information through their surfaces.

## 11. Do-Not-Track Signals

Some browsers offer a "Do Not Track" ("DNT") signal. The Platform does not respond to DNT signals because we do not engage in cross-site tracking or behavioral advertising for which DNT was designed. We do honor the "Opt Out of Sale or Sharing" signals (e.g., the Global Privacy Control header) for jurisdictions that legally require us to do so.

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

For purposes of California's CCPA/CPRA, the following categories of personal information are collected from business users in the prior twelve (12) months, the purposes for which collected, and the categories of third parties to whom disclosed (for business purposes; not for sale).

| Category (per CCPA § 1798.140) | Examples | Collected? | Disclosed for a business purpose? | Sold or shared? |
|---|---|---|---|---|
| A. Identifiers | name, email, phone, IP address, Stripe Connect ID | Yes | Yes — Stripe, Resend, Sentry, hosting provider | No |
| B. Personal information categories under Cal. Civ. Code § 1798.80 | name, address, phone, financial account information, employment | Yes | Yes — Stripe, Plaid, screening provider | No |
| C. Protected classification characteristics | date of birth (for KYC) | Yes — when required | Yes — Stripe Identity | No |
| D. Commercial information | rent collection history, fees paid, products purchased through POS | Yes | Yes — Stripe, hosting provider | No |
| E. Biometric information | selfie/face match during Stripe Identity verification (collected by Stripe, not stored by GAM) | No (Stripe collects directly) | N/A | No |
| F. Internet or other network activity | browsing history within the Platform, session telemetry | Yes | Yes — hosting provider, Sentry | No |
| G. Geolocation data | approximate location inferred from IP address | Yes (approximate only) | Yes — hosting provider | No |
| H. Audio, electronic, visual information | photos uploaded for maintenance tickets, property inspections | Yes | Yes — hosting provider | No |
| I. Professional or employment-related information | business information, PM company staff roles, bookkeeper roles | Yes | Yes — Stripe, hosting provider | No |
| J. Education information | Not collected | No | N/A | N/A |
| K. Inferences | None drawn for marketing or profiling purposes | No | N/A | N/A |
| L. Sensitive personal information | Social Security Number / ITIN, government ID, financial account numbers | Yes — when required for KYC or bank linking | Yes — Stripe Identity, Plaid (only for the regulated purpose) | No |

We retain each category of personal information for the period described in Section 5.
