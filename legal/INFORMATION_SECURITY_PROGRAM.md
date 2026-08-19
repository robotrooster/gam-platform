# Information Security Program

**Gold Asset Management (GAM)**
Version 1.0 — effective 2026-08-17
Owner: Nicholas Rhoades, Owner/Operator
Review cadence: annually, and on any material change to systems or data handling

---

## 1. Purpose and scope

This document describes the safeguards GAM maintains for the data it processes.
It reflects controls that are **implemented today**, not intentions. Where a
control is not yet in place, it is stated plainly in §12 rather than omitted.

Scope: the GAM platform — landlord, tenant, admin, property-management and
business portals; the API; the primary database; and the third-party processors
listed in §9.

GAM is a property-management software platform. It is **not** a lender, and it
does not perform credit underwriting or creditworthiness assessment. Data
obtained through bank connections is used solely to produce the connected
customer's own accounting records.

---

## 2. Data we handle

| Class | Examples | Handling |
|---|---|---|
| **Highly sensitive** | Bank account numbers, bank transaction history | Encrypted at rest; never rendered in full to any UI |
| **Sensitive** | Names, addresses, emails, phone numbers, lease terms, payment records | Access-controlled per record |
| **Credentials** | Passwords, session tokens, API keys, webhook secrets | Hashed or held in server-side environment configuration; never in source control |
| **Operational** | Audit logs, email delivery logs, product telemetry | Retained for accountability |

Payment card data is **never** stored by GAM. Card and bank payment
authorization is handled by Stripe; GAM stores only Stripe identifiers.

---

## 3. Encryption

**In transit.** All external traffic is HTTPS/TLS. The application server is not
directly exposed to the internet — no inbound ports are open. Traffic reaches it
through an authenticated Cloudflare tunnel.

**At rest.** Bank account numbers are encrypted with **AES-256-GCM** using a
dedicated 32-byte key held in server-side environment configuration, separate
from the database. Decryption occurs only at the moment of a payout or an
explicit, audited administrative reveal. Application interfaces display only the
last four digits.

---

## 4. Authentication and access control

- Passwords hashed with **bcrypt at 12 rounds**. Minimum length 12 characters,
  following NIST SP 800-63B guidance (length over composition rules).
- **Email-based two-factor authentication is mandatory** for landlord and
  administrative logins. A one-time code is required in addition to the password.
- **Account lockout** after 5 failed attempts, for 15 minutes, applied per
  account so the control is not defeated by distributing attempts across IPs.
- Authenticated sessions use signed, expiring tokens.
- **Authorization is enforced per record, not per route.** Every request for a
  specific record verifies that the requesting user owns or is scoped to it.
  This applies to file downloads as well as API data.
- Staff and contractor roles receive scoped permissions limited to the
  properties and functions they are assigned.

---

## 5. Application security

- Standard HTTP security headers applied platform-wide.
- Rate limiting on the API, with tighter limits on authentication and
  public-facing endpoints.
- All inbound webhooks (payment processor, email processor) are **signature
  verified** before processing; unverified payloads are rejected.
- Input validated against explicit schemas at the API boundary.
- Database access is parameterized; no string-built SQL.
- Automated test suite covering authorization boundaries and data-isolation
  rules, run before changes are deployed.

---

## 6. Logging and audit

GAM maintains append-only audit records covering administrative actions,
row-level data changes, authentication events and outbound email. Logs are used
for accountability and incident investigation, and are retained rather than
rotated away.

---

## 7. Data location and residency

All customer data is stored **within the United States**. The primary database
runs on hardware under GAM's direct physical control in Arizona. Backups are
retained on the same US-based infrastructure. GAM does not transfer, replicate
or process customer data outside the United States, and will only migrate
infrastructure to US-region providers.

---

## 8. Backup and recovery

Automated backups of the database and uploaded files run **nightly**, retained
on local infrastructure with dated snapshots. Backup freshness is monitored
automatically, and an alert is raised if a backup becomes overdue.

---

## 9. Third-party processors

GAM keeps platform data on its own servers. The following processors are used
for specific, limited functions:

| Processor | Purpose | Data shared |
|---|---|---|
| **Stripe** | Payments, payouts, identity verification, bank connections | Payment and identity data necessary to process transactions |
| **Resend** | Transactional email | Recipient address and message content |
| **Cloudflare** | Network transport and DNS | Traffic in transit only |
| **Vercel** | Static front-end hosting | No customer data; static assets only |

**Customer data is not sold, rented, or shared with third parties for their own
purposes.** Bank transaction data obtained through Stripe Financial Connections
is used exclusively to generate the connected customer's own bookkeeping records
and is shown only to that customer. It is not shared with other customers, other
landlords, advertisers, data brokers, or credit bureaus.

GAM does not send customer data to third-party artificial-intelligence or
machine-learning services. Language models used by the platform are self-hosted
on GAM-controlled hardware.

---

## 10. Vendor management

Processors are limited to those necessary to operate the platform. Each is a
recognized provider with its own published security posture. Credentials for
each are stored server-side, are not committed to source control, and can be
rotated independently.

---

## 11. Incident response

1. **Detect** — automated monitoring covers platform and vendor health, email
   deliverability, backup freshness and payment-processor status, alerting the
   owner on any transition into a failed state.
2. **Contain** — affected credentials are rotated and affected access revoked.
   Individual capabilities can be disabled independently without taking the
   platform down.
3. **Assess** — audit logs are used to establish what was accessed and by whom.
4. **Notify** — affected customers and, where applicable, regulators and
   processors are notified in accordance with applicable law.
5. **Remediate and record** — the cause is fixed and the change is covered by an
   automated test where one applies.

---

## 12. Known limitations

Stated deliberately, so this document is an accurate description rather than a
marketing claim:

- GAM holds **no third-party security certification** (SOC 2, ISO 27001). The
  controls above are self-assessed against those frameworks as references.
- GAM is operated by a **single owner/operator**. Separation of duties is
  therefore limited; this is mitigated by audit logging and by the platform
  never holding customer funds outside the payment processor.
- Infrastructure is **self-hosted on owner-controlled hardware**. Physical
  security is that of a private, access-controlled premises rather than a
  commercial data centre. Migration to a managed US-region host is planned as
  volume grows.
- Formal penetration testing has not been conducted.

These limitations are reviewed at each revision of this document.

---

## 13. Review

Reviewed at least annually and upon any material change to systems, processors
or data handling. Revisions are recorded by version and date at the top of this
document.
