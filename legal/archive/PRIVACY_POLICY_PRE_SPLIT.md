# Privacy Policy

**Gold Asset Management**
2843 East Frontage Road, Amado, AZ 85645
Effective Date: [DATE OF PUBLIC LAUNCH]
Last Updated: [DATE]

---

## 1. Introduction

This Privacy Policy explains how **Gold Asset Management LLC** ("**GAM**," "**we**," "**us**," "**our**") collects, uses, shares, and protects personal information when you use the GAM platform — including our websites, portals (landlord, tenant, admin, PM company, property intelligence, listings, marketing, GAM Books, and POS), APIs, and related services (collectively, the "**Platform**").

This Privacy Policy is part of, and incorporated by reference into, the [Terms of Service](./TERMS_OF_SERVICE.md). Capitalized terms not defined here have the meaning given in the Terms of Service.

If you do not agree to this Privacy Policy, do not use the Platform.

## 2. Who This Applies To

This Privacy Policy applies to all Users of the Platform, including:

- **Landlords** and property owners
- **Tenants** and rental applicants
- **Property Managers**, on-site managers, maintenance workers, and bookkeepers operating under a Landlord's account
- **PM Companies** and their staff
- Anyone who interacts with the Platform's public-facing surfaces (marketing site, listings)

## 3. Information We Collect

We collect personal information from three sources: (a) directly from you when you provide it; (b) automatically when you use the Platform; and (c) from third parties who provide it to us with your consent or as authorized by law.

### 3.1 Information You Provide

**Account information**: name, email address, phone number, password (stored only as a one-way bcrypt hash), preferred communication settings, time zone, and account role.

**Identity verification information** (collected when required to enable money movement, screening, or other regulated features): legal name, date of birth, residential address, government-issued identification number (Social Security Number or Individual Taxpayer Identification Number where required), photo identification document, and selfie verification (collected by Stripe Identity on our behalf).

**Property and business information** (Landlords and PM Companies): property addresses, ownership documentation, business entity information (legal name, state of formation, EIN), beneficial-owner information for Connect onboarding, and operational settings.

**Lease and tenancy information** (Landlords and Tenants): lease terms, monthly rent, security deposit, move-in date, move-out date, late-fee configuration, lease document, signed addenda, e-signature records.

**Payment information**: bank account number and routing number (for ACH onboarding via Plaid or Stripe Financial Connections; account numbers are encrypted at rest and we retain only the last four digits in unencrypted form), card information (handled by Stripe Elements; GAM does not store full card numbers), Stripe Connect account ID, and payment-method metadata.

**Tenant-screening information** (when a Landlord requests screening): consents, application disclosures, and the resulting consumer report data (credit summary, eviction history, criminal background, identity verification). This information is processed by the screening provider (Checkr, when active) and surfaced to the requesting Landlord under the Fair Credit Reporting Act framework.

**Communications**: in-platform messages between Landlords, Tenants, PM Companies, and managers; support emails sent to `support@goldassetmanagement.com`; survey responses; notification preferences; comments on inspections, entry requests, and maintenance tickets.

**Maintenance and inspection information**: photos, descriptions, and resolution notes for maintenance tickets and property inspections.

**Tax and bookkeeping information** (GAM Books users): payroll information for property employees (wages, hours, deductions); 1099-NEC contractor payments; chart-of-accounts data; manual journal entries.

### 3.2 Information We Collect Automatically

**Device and usage information**: IP address, browser type and version, operating system, device identifiers, referring URL, pages visited, features used, and timestamps. This information is collected through server logs and session telemetry.

**Cookies and similar technologies**: we use first-party session cookies to authenticate your session and remember your preferences. We do **not** use third-party advertising or cross-site tracking cookies. We do not participate in real-time bidding, retargeting networks, or behavioral advertising.

**Error and performance telemetry**: we use Sentry to capture uncaught application errors and server exceptions. Sentry events include the stack trace, the URL of the page where the error occurred, browser information, and a generated request ID. We have configured Sentry to **not** send personal information (no user emails, no IP addresses, no request bodies) by default; we filter expected 4xx client errors and capture only 5xx and uncaught exceptions.

### 3.3 Information From Third Parties

**Identity verification**: Stripe Identity returns verification status, ID document metadata, and selfie match results when you complete the Connect onboarding flow.

**Bank verification**: Plaid or Stripe Financial Connections returns bank account ownership data, account balance (snapshot only, not ongoing), and ACH eligibility status when you link a bank account.

**Background and credit reporting**: the screening provider (Checkr, when active) returns consumer reports under FCRA when a Tenant authorizes screening through a Landlord-initiated application.

**Payment processor data**: Stripe returns transaction status, payout history, dispute history, and chargeback notifications.

**Public records and third-party data sources** (Property Intelligence feature only): we aggregate property parcel data from county GIS databases for the Property Intelligence portal. This data is publicly accessible and is not associated with your account unless you have manually linked a parcel to a Property in your portfolio.

## 4. How We Use Information

We use personal information for the following purposes:

- **To provide the Platform**: enable account creation; authenticate sessions; configure properties; collect rent; process payouts to Landlords and PM Companies; run the deposit-return flow; deliver maintenance and inspection workflows; render the multi-portal dashboard surfaces.
- **To process payments and money movement**: route inbound tenant rent through the Payment Rail; settle outbound payouts to Landlord and PM Company Connect balances; calculate and collect Platform fees; reconcile chargebacks and ACH returns.
- **To verify identity and authorize money movement**: complete KYC verification via Stripe Identity before activating Connect accounts; verify bank account ownership via Plaid or Stripe Financial Connections; comply with anti-money-laundering and sanctions-screening requirements.
- **To run tenant screening with consent**: order consumer reports from the screening provider; deliver adverse-action notices when required by FCRA; surface report results to the Landlord who initiated the screening.
- **To communicate with you**: send transactional emails (registration confirmation, password reset, rent receipts, payout notifications, maintenance updates, dispute notifications); send service announcements; respond to support inquiries.
- **To surface state-specific compliance information**: display state deposit interest rates and state tax form deadlines applicable to your property's state, sourced from the Platform's catalog of state-specific data.
- **To detect and prevent fraud, abuse, and security incidents**: review login patterns; rate-limit authentication attempts; investigate chargebacks; respond to security alerts.
- **To improve the Platform**: analyze aggregate usage patterns; debug errors via Sentry; refine product features.
- **To comply with legal obligations**: respond to subpoenas, court orders, and regulatory requests; report tax information (e.g., 1099-K issuance via Stripe); maintain records required by law.

We do **not** use personal information for behavioral advertising, profiling for marketing purposes, or training of artificial intelligence or machine learning models for external use. Internal model training, if any, is limited to anonymized, aggregated metrics — and as of this Privacy Policy's effective date, GAM does not train models on user data.

## 5. How We Share Information

We share personal information only as described below. We do **not** sell personal information to third parties for any purpose.

### 5.1 With Other Users of the Platform

The Platform is multi-party by design. Some of your information is visible to other Users:

- **Landlords and PM Companies** can see Tenant contact information, lease details, payment history, screening report results (where the Landlord requested and the Tenant authorized screening), and maintenance communications for their own units.
- **Tenants** can see Landlord and Property Manager contact information, lease documents, payment receipts, and maintenance ticket history for their own tenancy.
- **PM Companies** can see Landlord information for properties they manage and Tenant information for those properties.
- **Sub-users** (Property Managers, maintenance workers, on-site managers, bookkeepers) see only the information their assigned scope permits.

The Platform's audit trail logs material actions taken by sub-users and is visible to the Landlord or PM Company that authorized them.

### 5.2 With Service Providers

We share personal information with third-party service providers who process it on our behalf to enable the Platform. Each service provider is contractually bound to use the information only for the purpose for which we engaged them and to protect it consistent with applicable law. Current service providers include:

- **Stripe, Inc.** — payment processing, Connect onboarding (Express), Identity verification, Radar fraud screening, Financial Connections bank verification.
- **Resend, Inc.** — transactional email delivery.
- **Plaid Inc.** — bank account verification for ACH onboarding (in some regions and use cases).
- **Checkr, Inc.** (when activated) — tenant screening and background checks.
- **Functional Software, Inc. d/b/a Sentry** — application error tracking.
- The hosting and database provider that hosts the Platform's infrastructure.

We may add, remove, or substitute service providers from time to time. The list above reflects our current set as of the effective date of this Privacy Policy.

### 5.3 As Required by Law

We may disclose personal information when we believe in good faith that disclosure is required by:

- A subpoena, court order, or other valid legal process;
- A request from a law enforcement authority, regulator, or government agency with jurisdiction over us;
- A legal obligation under applicable tax, anti-money-laundering, or consumer-protection law (including issuance of 1099 forms by Stripe);
- The need to enforce these Terms or protect the rights, property, or safety of GAM, our Users, or the public.

Where legally permitted, we will notify affected Users before disclosing their information in response to a legal demand.

### 5.4 In Connection With a Business Transaction

If GAM is acquired, merges with another entity, sells substantially all of its assets, or undergoes a similar corporate transaction (including bankruptcy or assignment for the benefit of creditors), personal information may be transferred to the acquiring entity as part of the transaction, subject to the terms of this Privacy Policy or a successor policy that provides equivalent protection. We will notify affected Users of any such transfer where required by law.

### 5.5 With Your Consent

We may share personal information for other purposes when you direct us to do so or otherwise consent.

## 6. Data Retention

This retention policy applies to all Users of the Platform — Landlords, Tenants, Property Managers, PM Companies, ancillary roles, and applicants — without exception.

**GAM retains personal information indefinitely.** GAM does not impose a routine deletion schedule, expiration period, or automatic purge against any category of personal information. Financial transaction records, lease history, payment history, tenant-screening reports, identity-verification documentation, communications, maintenance and inspection records, audit logs, and security telemetry all have ongoing operational, fraud-detection, regulatory, dispute-defense, and litigation-preparedness value that persists indefinitely beyond the duration of any individual tenancy, transaction, or account. We intend to retain personal information for the full lifetime of GAM's operations.

**GAM deletes personal information only when legally compelled to do so.** A User's right under state privacy law to *request* deletion is not the same as a legal mandate that GAM *perform* deletion; the privacy laws of every state that grants a deletion right also grant the business broad statutory exceptions that permit continued retention. **GAM applies each available statutory exception to the maximum extent permitted by law.** As a result, deletion occurs only in the following narrow circumstances:

- A court of competent jurisdiction issues an order directing deletion;
- A regulator with authority over GAM issues a binding order or rule mandating deletion;
- A federal or state law affirmatively requires deletion that cannot be lawfully refused under any available exception — for example, the Children's Online Privacy Protection Act (COPPA) requirement to delete personal information inadvertently collected from a child under thirteen, or a narrowly drawn state-law retention cap for a specific data category; or
- A verifiable consumer deletion request is submitted under a state privacy law (e.g., CCPA/CPRA, VCDPA, CPA, CTDPA, UCPA, TDPSA, OCPA), **and** after GAM has applied each statutory exception available under that law, no permitted retention basis remains for any portion of the requested data. The statutory exceptions are broad — they include retention for completing transactions, providing goods or services requested by the User, detecting security incidents, identifying and preventing fraud, complying with legal obligations, exercising or defending legal claims, performing internal uses reasonably aligned with the relationship in which the personal information was collected, exercising free speech, and others. In practice, almost all categories of personal information GAM holds fall within one or more of these exceptions, and the practical effect of a deletion request is that GAM retains the personal information.

Where a federal or state law mandates a *minimum* retention period (for example, the Fair Credit Reporting Act's retention rules for consumer reports and adverse-action notices, or IRS recordkeeping rules for financial transactions), GAM retains at least for that period and continues to retain indefinitely thereafter under the default policy above.

**Backup snapshots.** Operational disaster-recovery snapshots are retained on a rolling ninety (90) day window. When personal information is deleted from primary storage under one of the legal-compulsion triggers above, the deletion propagates to backup snapshots on the next applicable backup cycle.

## 7. Data Security

We use commercially reasonable administrative, technical, and physical safeguards to protect personal information. These include:

- TLS encryption for all data in transit between your device and the Platform;
- Encryption at rest for sensitive fields, including bank account numbers (encrypted at the column level with rotating keys) and password hashes (one-way bcrypt with cost factor tuned to current best practice);
- Card data is handled by Stripe and tokenized; GAM does not store full card numbers and is not PCI-DSS Level 1 compliant by virtue of storing card data, because we do not store it;
- Two-factor authentication required for all administrative and super-administrative accounts and optional for Landlord, PM Company, and Tenant accounts;
- Role-based access controls limit sub-user access to only the units, properties, or features they have been scoped to;
- Per-account login lockout after five failed attempts within fifteen minutes; tighter rate-limiting on the login endpoint to defend against credential-stuffing;
- Application monitoring via Sentry; structured logging via Pino for forensic traceability;
- Regular review of access permissions and authentication logs.

No system is impenetrable. **In the event of a data breach affecting your information, we will notify you and applicable regulators consistent with the breach-notification laws of your state of residence.**

## 8. Your Privacy Rights

### 8.1 Rights Available to All Users

You may, at any time:

- **Access** the personal information we hold about you. Many surfaces are visible directly within the Platform; for information not surfaced in-product, email `support@goldassetmanagement.com` with a request.
- **Correct** inaccurate or incomplete personal information through your account profile or by emailing us.
- **Close your account.** Closing your account ends your access to the Platform but, as described in Section 6, **does not by itself trigger deletion of the personal information already collected.** Personal information continues to be retained per the policy in Section 6.
- **Submit a deletion request** under a state privacy law that grants you that right (see Section 8.2 below for state-specific rights). Deletion requests are evaluated against the statutory exceptions available to GAM under the applicable law and against the retention policy in Section 6. As described in Section 6, GAM applies each available exception to the maximum extent permitted, with the result that personal information is typically retained.
- **Export** a copy of your personal information in a structured, commonly used format.
- **Opt out of marketing email**. Note that we do not currently send marketing email; if we begin to do so, opt-out links will be included in each such message. Transactional emails (related to your account and active transactions) are not subject to opt-out.

To exercise these rights, email `support@goldassetmanagement.com` with a description of the request. We may need to verify your identity before we can act on the request. We will respond within thirty (30) days, or, where the law of your state requires a shorter response window, within that window.

### 8.2 Rights for California Residents (CCPA / CPRA)

If you are a California resident, you have additional rights under the California Consumer Privacy Act, as amended by the California Privacy Rights Act:

- **Right to know** the categories and specific pieces of personal information we have collected about you, the sources from which we collected it, the purposes for which we collected it, and the categories of third parties with whom we shared it. The disclosures in Sections 3, 4, and 5 above describe our practices in the aggregate. You may submit a verifiable request for the specific information we hold about you.
- **Right to delete** personal information we have collected from you, subject to statutory exceptions.
- **Right to correct** inaccurate personal information.
- **Right to opt out of sale or sharing** of personal information. **We do not sell or share personal information as those terms are defined under California law.**
- **Right to limit use of sensitive personal information**. The sensitive personal information we collect (Social Security Number for KYC, government ID for verification, financial account numbers, precise geolocation if any) is used only for the purpose of providing the Platform and complying with legal obligations.
- **Right to non-discrimination** for exercising these rights.

We do not knowingly collect personal information from minors under sixteen (16) and do not sell or share personal information of minors.

To submit a CCPA/CPRA request, email `support@goldassetmanagement.com` with "California Privacy Request" in the subject line.

### 8.3 Rights for Other State Residents

We also recognize the rights granted by the privacy laws of Virginia (VCDPA), Colorado (CPA), Connecticut (CTDPA), Utah (UCPA), Texas (TDPSA), Oregon (OCPA), Montana, Iowa, Tennessee, Indiana, and Delaware. Residents of those states have rights substantially similar to those listed in Section 8.2 above. To exercise them, follow the same process — email `support@goldassetmanagement.com` with a description of your request.

### 8.4 Appeals

If we decline a request, you may appeal the decision by emailing `support@goldassetmanagement.com` with "Privacy Appeal" in the subject line. We will respond to the appeal within forty-five (45) days, or within a shorter period if required by the law of your state. If we deny the appeal, you may contact your state's Attorney General's office to file a complaint.

## 9. Children's Privacy

The Platform is not directed to children under eighteen (18) and is not intended for use by anyone under eighteen. We do not knowingly collect personal information from children under thirteen (13) in violation of the Children's Online Privacy Protection Act ("COPPA").

If we learn that we have collected personal information from a child under thirteen, we will delete it promptly. If you believe a child under thirteen has provided us with personal information, contact `support@goldassetmanagement.com`.

## 10. International Users

The Platform is operated from the United States and is intended for use by Users located in the United States. Personal information is stored and processed in the United States. If you access the Platform from outside the United States, you understand that your information will be transferred to and processed in the United States, which may have data-protection laws that differ from those of your jurisdiction.

GAM does not currently offer the Platform in the European Economic Area, the United Kingdom, Switzerland, or other jurisdictions covered by the General Data Protection Regulation. If we begin to offer the Platform in those regions, this Privacy Policy will be updated with a region-specific addendum.

## 11. Third-Party Links and Services

The Platform may link to or integrate with third-party websites and services that operate under their own privacy policies (e.g., the Stripe Connect-hosted onboarding pages, Plaid's bank-link interface, Checkr's screening interface). We are not responsible for the privacy practices of those third parties. Review the relevant third party's privacy policy before providing personal information through their surfaces.

## 12. Do-Not-Track Signals

Some browsers offer a "Do Not Track" ("DNT") signal. The Platform does not respond to DNT signals because we do not engage in cross-site tracking or behavioral advertising for which DNT was designed. We do honor the "Opt Out of Sale or Sharing" signals (e.g., the Global Privacy Control header, where the signal indicates the request originates from California or another applicable state) for jurisdictions that legally require us to do so.

## 13. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. The "Last Updated" date at the top reflects when the most recent changes took effect. For material changes, we will notify you by email to the address on file and by in-platform notification at least thirty (30) days before the changes take effect, except where a shorter notice period is required by law or security necessity.

We will maintain prior versions of this Privacy Policy for thirty-six (36) months after they are superseded.

## 14. Contact

Questions, requests, complaints, or feedback regarding this Privacy Policy? Email `support@goldassetmanagement.com` or write to:

Gold Asset Management LLC
Attn: Privacy
2843 East Frontage Road
Amado, AZ 85645

For state-specific privacy requests, please include the relevant state law in your subject line (e.g., "California Privacy Request," "Virginia Privacy Request") so we can route the request promptly.

---

## Appendix A — Categories of Personal Information Under CCPA/CPRA

For purposes of California's CCPA/CPRA, we disclose the following categories of personal information collected in the prior twelve (12) months, the purposes for which collected, and the categories of third parties to whom disclosed (for business purposes; not for sale).

| Category (per CCPA § 1798.140) | Examples | Collected? | Disclosed for a business purpose? | Sold or shared? |
|---|---|---|---|---|
| A. Identifiers | name, email, phone, IP address, Stripe Connect ID | Yes | Yes — Stripe, Resend, Sentry, hosting provider | No |
| B. Personal information categories under Cal. Civ. Code § 1798.80 | name, address, phone, financial account information, employment | Yes | Yes — Stripe, Plaid, screening provider | No |
| C. Protected classification characteristics | date of birth, marital status, military or veteran status (only when collected for screening or KYC) | Yes — when required | Yes — screening provider, Stripe Identity | No |
| D. Commercial information | rent payment history, fees paid, products purchased through POS | Yes | Yes — Stripe, hosting provider | No |
| E. Biometric information | selfie/face match during Stripe Identity verification (collected by Stripe, not stored by GAM) | No (Stripe collects directly) | N/A | No |
| F. Internet or other network activity | browsing history within the Platform, session telemetry | Yes | Yes — hosting provider, Sentry | No |
| G. Geolocation data | approximate location inferred from IP address | Yes (approximate only) | Yes — hosting provider | No |
| H. Audio, electronic, visual information | photos uploaded for maintenance tickets, property inspections, lease documents | Yes | Yes — hosting provider | No |
| I. Professional or employment-related information | landlord business information, PM company staff roles, bookkeeper roles | Yes | Yes — Stripe, hosting provider | No |
| J. Education information | Not collected | No | N/A | N/A |
| K. Inferences | None drawn for marketing or profiling purposes | No | N/A | N/A |
| L. Sensitive personal information | Social Security Number / ITIN, government ID, financial account numbers, precise geolocation if any | Yes — when required for KYC, screening, or bank linking | Yes — Stripe Identity, Plaid, screening provider (only for the regulated purpose) | No |

We retain each category of personal information for the period described in Section 6.
