/**
 * S583 — camelCase wire-contract guard (see test/wireContractScan.ts for the WHY).
 *
 * The API serves camelCase to every frontend; a frontend that reads snake_case
 * off a response gets `undefined` in production, and route tests (bare apps, no
 * camelize middleware) can't catch it. This guard scans each portal's source for
 * `obj.snake_case` reads and fails if an app grows past its recorded BASELINE —
 * so a newly-introduced snake_case read trips a test the moment it lands.
 *
 * RATCHET: when a subsystem sweep verifies/fixes an app's reads, LOWER its
 * baseline here (never raise it). Annotate a legitimate snake read (Stripe SDK
 * object, local const map, enum value) with a `// wire-ok` comment on that line
 * instead of baselining it. `tenant` was swept in S583 → baseline 0.
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import { scanApp } from './test/wireContractScan'

const APPS_DIR = path.join(__dirname, '..', '..') // apps/

// Max allowed snake_case member-reads per portal. Current known counts as of
// S583. `tenant` is swept + clean (0). The rest are un-swept — their real bug
// count is unknown; the baseline just prevents GROWTH until each portal's own
// subsystem sweep verifies its reads and ratchets this down.
const BASELINE: Record<string, number> = {
  tenant:          0,   // ✅ swept S583 (Subsystem 6) — keep at 0
  landlord:        0,   // ✅ swept S594 — dead snake fallbacks removed; NotificationsPage jsonb
                        //    read fixed (data blob IS camelized); ConfirmIntentModal local-const
                        //    map annotated `// wire-ok`. Keep at 0.
  business:        0,   // ✅ swept S594 — GlobalSearch workOrders (search group never rendered),
                        //    DumpLocations/Vehicles/StripeConnect account-status fixed; dead fallbacks removed.
  fitness:         0,   // ✅ swept S594 — all 19 were request-body / local-form-state reads (snake by
                        //    design, server reads snake off req.body); annotated `// wire-ok`, no bugs.
  storefront:      0,   // ✅ swept S593 — baseline was left stale at 10; real count is 0
  admin:           0,   // ✅ swept S594 — arc-closer speed report read 8 snake fields off a
                        //    camelized response (rendered blank); all fixed to camelCase.
  'pm-company':    0,   // ✅ Subsystem 19 swept (S593) — AgentActivityPage camelize fixed
  'admin-ops':     0,
  pos:             0,
  books:           0,
  listings:        0,
  'property-intel':0,
  marketing:       0,
  customer:        0,
}

describe('camelCase wire-contract guard (frontend must not read snake_case off API responses)', () => {
  for (const [app, max] of Object.entries(BASELINE)) {
    it(`${app}: no new snake_case response reads (baseline ${max})`, () => {
      const { count, hits } = scanApp(APPS_DIR, app)
      if (count > max) {
        // Show only the overflow so the failure names the new offenders.
        const detail = hits.slice(0, 40).join('\n')
        throw new Error(
          `${app} has ${count} snake_case member-reads, baseline is ${max}. A new ` +
          `snake_case read off an API response is a camelize bug (API serves camelCase). ` +
          `Fix the read (use the camelCase field) or annotate a legitimate one with ` +
          `\`// wire-ok\`.\n${detail}`
        )
      }
      expect(count).toBeLessThanOrEqual(max)
    })
  }

  it('tenant stays fully clean (guards the S583 sweep)', () => {
    expect(scanApp(APPS_DIR, 'tenant').count).toBe(0)
  })
})
