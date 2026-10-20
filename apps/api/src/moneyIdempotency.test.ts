/**
 * S594 — money-charge idempotency completeness guard.
 *
 * A recurring/cron-billed charge that can double-fire (a second API instance, an
 * overlapping tick, a lost-response retry) MUST carry an idempotency backstop, or
 * the tenant gets double-charged. `home_payment` shipped WITHOUT one and was only
 * caught in the S594 sweep — this guard makes that failure mode loud.
 *
 * It parses `payments.type` out of schema.sql and forces every value into exactly
 * one bucket: backed by a `ux_payments_*` partial-unique index, or idempotent by a
 * documented OTHER mechanism. Adding a new `payments.type` (or dropping an index)
 * FAILS this test until someone consciously records how the new charge stays
 * single-fired. Pure schema parse — no DB, fast, deterministic.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8')

/**
 * The migrations not in schema.sql yet (it is re-dumped only when migrations
 * reach production). A backstop that ships as a pending migration is still a
 * real backstop, so it counts here — and this way the guard starts holding the
 * index the day it is written instead of the day it is applied.
 */
const MIGRATIONS_DIR = path.join(__dirname, 'db', 'migrations')
const migrationsSql = fs.readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql'))
  .map(f => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n')

/** TRUE when some .sql in the tree creates this unique index. */
function indexIsCreated(idx: string): boolean {
  const re = new RegExp(`CREATE UNIQUE INDEX (IF NOT EXISTS )?${idx}\\b`)
  return re.test(schema) || re.test(migrationsSql)
}

// Every payment type MUST be categorized. A new type not listed here trips the
// completeness assertion below — the whole point: no silent new money charge.
const BACKED_BY_UX_INDEX: Record<string, string> = {
  rent:         'ux_payments_rent_idempotent (+ ux_payments_unit_rent_due_date_active)',
  fee:          'ux_payments_fee_idempotent',
  late_fee:     'ux_payments_late_fee_idempotent',
  home_payment: 'ux_payments_home_sale_installment',
}
const IDEMPOTENT_BY_OTHER: Record<string, string> = {
  utility:      'invoiceGeneration stamps utility_bill/propane_fill_installment.payment_id under the `payment_id IS NULL` filter (application-level single-fire)',
  deposit:      'one-shot at move-in (jobs/moveInBundle) — not recurring',
  float_fee:    'FlexPay accrual is guarded upstream in services/flexpay (per-cycle), not re-billed by a payments cron',
  platform_fee: 'platform-fee accrual is guarded in jobs/platformFeeAccrual (per unit/month), not re-billed by a payments cron',
  // S609: found BY this guard — carried_balance shipped without a declaration.
  // A landlord types an opening balance in by hand; there is no cron. The route
  // checked for an existing one and then inserted, which races, so S609 added
  // ux_invoices_one_opening_balance_per_lease to make the rule real. The route's
  // own check stays for the friendly 409.
  // 10/19 (Nic): a SECOND way a carried_balance row is written — unpaid space
  // rent carried to the space when the previous owner of a tenant-owned home
  // leaves. It has no invoice at all (that is what keeps the late-fee engine
  // away from it), so the opening-balance index above cannot cover it; its own
  // index does. Both are one-shots a human presses, neither has a cron.
  // 10/19 review: the close-out's second press is actually stopped FIRST by
  // ux_space_rent_carryforward_open_per_unit — one open claim per space, and
  // the claim is inserted before its charge — so both indexes are named, and
  // the test below holds all three to existing.
  carried_balance: 'ux_invoices_one_opening_balance_per_lease — one opening-balance invoice per lease, DB-enforced (S609); '
    + 'ux_space_rent_carryforward_open_per_unit — one open carried space-rent claim per space, DB-enforced (10/19); '
    + 'ux_payments_one_space_carryforward_charge — one live carried space-rent charge per claim, DB-enforced (10/19); '
    + 'landlord-entered one-shots, no cron',
}

function parsePaymentTypes(): string[] {
  const m = schema.match(/payments_type_check CHECK \(\(type = ANY \(ARRAY\[([^\]]+)\]/)
  if (!m) throw new Error('could not find payments_type_check in schema.sql')
  return [...m[1].matchAll(/'([a-z_]+)'::text/g)].map(x => x[1])
}

describe('money-charge idempotency completeness', () => {
  it('every payments.type is categorized (a new type must consciously declare its single-fire mechanism)', () => {
    const types = parsePaymentTypes()
    const categorized = new Set([...Object.keys(BACKED_BY_UX_INDEX), ...Object.keys(IDEMPOTENT_BY_OTHER)])
    const uncategorized = types.filter(t => !categorized.has(t))
    expect(uncategorized, `New payments.type(s) ${JSON.stringify(uncategorized)} — add each to BACKED_BY_UX_INDEX ` +
      `(with a ux_payments_* partial-unique index + ON CONFLICT in its billing insert) or IDEMPOTENT_BY_OTHER ` +
      `(with the mechanism that stops a double-charge).`).toEqual([])
    // and nothing categorized that no longer exists (keep the doc honest)
    const stale = [...categorized].filter(t => !types.includes(t))
    expect(stale, `Categorized payments.type(s) ${JSON.stringify(stale)} no longer in the CHECK — remove them.`).toEqual([])
  })

  /**
   * 10/19 review: this used to check the FIRST index named in BACKED_BY_UX_INDEX
   * and nothing else, so every index named anywhere else — the second one of a
   * pair, and every index named in IDEMPOTENT_BY_OTHER — could be renamed,
   * dropped or never written and the guard would still pass. A declaration
   * nothing verifies is a comment, not a backstop; carried_balance's two were
   * exactly that. Now EVERY ux_ index either map names has to exist.
   */
  it('every index named in either declaration exists (a named backstop is never just a comment)', () => {
    const named = [...Object.entries(BACKED_BY_UX_INDEX), ...Object.entries(IDEMPOTENT_BY_OTHER)]
      .flatMap(([type, note]) => [...note.matchAll(/\bux_[a-z0-9_]+/g)].map(m => ({ type, idx: m[0] })))
    expect(named.length, 'no index names parsed out of the declarations — the regex or the notes changed').toBeGreaterThan(5)
    const missing = named.filter(n => !indexIsCreated(n.idx)).map(n => `${n.type}: ${n.idx}`)
    expect(missing, `Named idempotency index(es) that no migration or schema.sql creates — ` +
      `either the backstop was dropped/renamed, or the declaration above names an index that was never written.`).toEqual([])
  })
})
