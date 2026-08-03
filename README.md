# ⚡ Gold Asset Management — Platform

Full-stack, multi-portal property management SaaS for landlords, tenants, RV parks, and extended-stay operators — built for nationwide scale.

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

### Eviction Mode

- Activated per unit by the landlord in the dashboard
- Hard-blocks ALL tenant rent payment at the platform level (accepting rent can waive the right to evict — landlord-configurable with a generic "check your local laws" disclaimer; no state-specific citations)
- `payment_block` field on `units`, enforced in the payment-initiation paths

### NACHA return monitoring

- Return rates tracked in `ach_monitoring_log`; the Admin **NACHA Monitor** page surfaces them
- Zero-tolerance unauthorized codes (R05 / R07 / R10 / R29) flag for immediate ACH suspension
- While on the Stripe rail, Stripe is the ACH originator and owns the NACHA relationship; GAM monitors to keep its own portfolio clean

---

## Business Model, Pricing & Legal Posture

**Single source of truth: `CLAUDE.md`** (loaded every session, kept current), plus the memory files and `LAUNCH.md`. Deliberately **not duplicated here** — a second, frozen copy of the strategy is exactly what let stale numbers resurface. Current-model orientation only:

- **Rent money flow** — platform-holds: every payment lands on GAM's Stripe platform balance, then batches to landlords weekly (lands by Friday). No advance, no guarantee. Detail in `MONEY_FLOW_REBUILD_SPEC.md`.
- **Platform fee** — $2 per occupied unit / month, floored at $10 per property. Vacant units are never charged.
- **Flex Suite** — custody / payment-coordination model; **GAM extends no credit**. FlexPay is a flat $25/mo. Full rules in `CLAUDE.md`.
- **Legal** — ToS/Privacy live in `legal/`; lawyer review advised before broad public rollout (tracked in `LAUNCH.md`).

> **Removed 2026-07-28** — the prior "Locked Model v3" sections (On-Time Pay advance/SLA, per-unit economics at a $15/mo landlord fee + $20 float, Arizona § citations, the reserve-phase table). All superseded by the current custody / platform-holds model. Git history preserves the originals.

## ODFI Transition (scale milestone, not a launch item)

Direct-ODFI origination (moving off the Stripe ACH rail) is targeted at roughly **2,000–3,000 units**, with no-cost relationship-building conversations starting around **500 units** — it materially cuts per-transaction ACH cost at scale. A **SOC 2 (Type II)** report is effectively a prerequisite for a sponsor-bank/ODFI relationship (a security-posture credential, separate from NACHA return metrics). Superseded per-unit dollar figures removed 2026-07-28; see `CLAUDE.md` for current economics.

---

## License

Proprietary — Gold Asset Management, LLC. All rights reserved.
