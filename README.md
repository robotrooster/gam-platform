# ⚡ Gold Asset Management — Platform

Full-stack SaaS property management platform with **On-Time Pay Disbursement SLA** — rent guaranteed to landlords on the 1st business day of every month.

---

## Architecture

```
gam/
├── apps/
│   ├── api/           Node/Express API — port 4000
│   ├── landlord/      React — Landlord portal — port 3001
│   ├── tenant/        React — Tenant portal — port 3002
│   ├── admin/         React — Internal ops console — port 3003
│   └── marketing/     Static HTML — Public site — port 3004
├── packages/
│   └── shared/        TypeScript types, constants, utilities
└── docker-compose.yml Postgres + pgAdmin
```

---

## Prerequisites

- Node.js 18+
- npm 9+
- Docker (for Postgres) OR a local Postgres 14+ instance
- A Stripe account (test keys fine for development)

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo>
cd gam
npm install
```

### 2. Start Postgres

```bash
docker-compose up -d
```

Postgres runs on `localhost:5432`. pgAdmin at `http://localhost:5050` (admin@gam.dev / admin).

### 3. Configure environment

```bash
cp .env.example apps/api/.env
# Edit apps/api/.env with your values
```

Minimum required for dev:
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=gam
DB_USER=postgres
DB_PASSWORD=gam_dev_password
JWT_SECRET=any_64_char_random_string
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Also create frontend env files:
```bash
echo "VITE_API_URL=http://localhost:4000" > apps/landlord/.env
echo "VITE_API_URL=http://localhost:4000" > apps/tenant/.env
echo "VITE_API_URL=http://localhost:4000" > apps/admin/.env
```

### 4. Run database migration

```bash
npm run db:migrate
```

### 5. Seed demo data

```bash
npm run db:seed
```

Demo credentials seeded:
| Role     | Email                  | Password      |
|----------|------------------------|---------------|
| Admin    | admin@gam.dev          | admin1234     |
| Landlord | james@demo.dev         | landlord1234  |
| Landlord | maria@demo.dev         | landlord1234  |
| Tenant   | alice@tenant.dev       | tenant1234    |
| Tenant   | bob@tenant.dev         | tenant1234    |

### 6. Start all apps

```bash
npm run dev
```

This starts all 5 services concurrently:

| App         | URL                      |
|-------------|--------------------------|
| API         | http://localhost:4000    |
| Landlord    | http://localhost:3001    |
| Tenant      | http://localhost:3002    |
| Admin       | http://localhost:3003    |
| Marketing   | http://localhost:3004    |

---

## Stripe Setup

### Stripe Connect (for landlord disbursements)

1. Enable Stripe Connect in your [Stripe dashboard](https://dashboard.stripe.com/connect/accounts/overview)
2. Set account type to **Express**
3. Enable **US Bank Account (ACH)** payments
4. Add redirect URIs: `http://localhost:3001/onboarding`

### Stripe Webhooks (for payment status)

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Forward webhooks to local API
stripe listen --forward-to localhost:4000/webhooks/stripe
```

Events to handle (already wired in `apps/api/src/routes/webhooks.ts`):
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payout.paid`

---

## Key Business Logic

### On-Time Pay SLA

- Cron job runs last business day of month (`apps/api/src/jobs/scheduler.ts`)
- Disbursements initiated regardless of tenant ACH settlement status
- Gap funded from `reserve_fund_state` table if tenant hasn't settled
- Standard tenants: ACH pulled on 28th, settles by 1st (3-day float)
- SSI/SSDI tenants enrolled in On-Time Pay: ACH pulled on income arrival day

### Eviction Mode

- Activated per unit by landlord in dashboard
- Hard-blocks ALL tenant ACH at platform level
- Legal basis: A.R.S. § 33-1371(A) — accepting any rent waives eviction right
- `payment_block` field on `units` table, enforced in payment initiation jobs

### Reserve Phases

| Phase | Units       | Reserve Rate |
|-------|-------------|-------------|
| 1     | 0–1,000     | 100% of net |
| 2     | 1,001–5,000 | 30% of net  |
| 3     | 5,000+      | 15% of net  |

### NACHA Compliance (June 22, 2026 deadline)

Zero-tolerance return codes (immediate ACH suspension):
- R05 — Unauthorized debit
- R07 — Authorization revoked
- R10 — Customer advises not authorized
- R29 — Corporate customer advises not authorized

Monitored via `ach_monitoring_log` table. Admin NACHA Monitor page tracks return rates.

---

## Pending (Attorney Review Required)

Per locked model v3:

1. SLA structure — does it avoid insurance classification per A.R.S. § 20-103?
2. Agent-of-payee structure — does it avoid money transmission licensing?
3. Non-recourse design — does it avoid consumer lending regulation?
4. $20 float fee — is it a finance charge under TILA?
5. A.R.S. § 20-1095 service contracts — does it apply?

**Do not launch in production without attorney sign-off on these five questions.**

---

## Per-Unit Economics (Locked Model v3)

| Item                        | Amount        |
|-----------------------------|---------------|
| Landlord fee (occupied)     | $15.00/mo     |
| ACH pull (0.8% × rent, cap $5) | −$4.80/mo  |
| Connect payout (0.25% + $0.25) | −$1.75/mo  |
| Connect account fee         | −$0.04/mo     |
| **Net before reserve**      | **$8.41/mo**  |
| Phase 3 reserve (15%)       | −$1.26/mo     |
| **Net kept (Phase 3)**      | **$7.15/mo**  |
| All-source ARR per unit     | **$255/year** |

---

## ODFI Transition (Month 24 target)

At 2,000–3,000 units, transition from Stripe ACH to direct ODFI:
- Stripe cost drops from $6.59/unit → $0.72/unit
- Net per unit jumps from $8.41 → $14.28 before reserve
- Begin ODFI conversations at 500 units (no cost, builds relationship)

---

## License

Proprietary — Gold Asset Management, LLC. All rights reserved.
