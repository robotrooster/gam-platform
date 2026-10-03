/**
 * S654 (2026-10-03) — the Harlands were at Oak Park RV 22 through August 31,
 * not in APT 04. Nic: "add that charge to theirs... if we did charge them
 * anything on the apartment water, we need to subtract that from the $24.93.
 * Also subtract the amount off of each person's [share]... RV 22's electric
 * August. And remove the 10.45."
 *
 * Back Row master 22720, August bill $74.79, re-split by headcount with the
 * Harlands (2 people) at RV 22: 6 people → $24.93 Harlands, $12.45 RV 20,
 * $12.47 RV 23 / RV 24 / RV 25 (sums to $74.79).
 *
 *   1. RV 20 (paid $18.69) → share $12.45 → $6.24 overcharge credit.
 *      RV 24 (paid $18.70) → share $12.47 → $6.23 overcharge credit.
 *      RV 23, RV 25 (unpaid $18.70) → line and invoice reduced to $12.47.
 *   2. Harlands: a $24.93 RV 22 August water bill; the line on their open
 *      October invoice is $14.48 = $24.93 less the $10.45 August apartment
 *      water they already paid (that bill keeps its paid amount, noted).
 *   3. Harlands: RV 22 August electric, 10,966 → 11,076 = 110 kWh × $0.21 =
 *      $23.10, on the same October invoice.
 * The Main master's August split is NOT re-billed to anyone else: the park
 * covers the $10.45 the Harlands no longer owe there (Nic: "remove the 10.45").
 *
 * One transaction. DRY=1 (default) prints before/after and rolls back:
 *   DRY=1 node -r ts-node/register src/scripts/oct3_harland_rv22_august.ts
 *   DRY=0 node -r ts-node/register src/scripts/oct3_harland_rv22_august.ts
 */
import { getClient } from '../db'

// Neighbor-facing wording never names another household (notes are tenant-visible labels).
const NEIGHBOR_NOTE = 'Corrected 10/3: August back-row water re-split — RV 22 was occupied in August and is now counted'
const HARLAND_NOTE = 'Corrected 10/3: you were at RV 22 through Aug 31, so your August water is your share of the back-row meter'
const CREATED_BY = '8b2f26ad-173a-45cb-9c59-f7a27bfa81e3'   // same login that issued the existing Harland credit
const BACK_ROW_METER = '8e3ca8cb-feb0-4726-b82d-cf234bc92b42'
const RV22_ELECTRIC_METER = '2c452d3d-b2d5-408e-9126-927fa3fe1b25'
const RV22_UNIT = '1316c82e-10d6-4a33-b51e-ebf6c537316e'
const HARLAND_LEASE = '49f3144a-d73c-4b3b-a82c-0d21f5852130'
const HARLAND_TENANT = '8dde1676-8fbb-4561-a5fe-997d3da17667'   // Kim (primary)
const HARLAND_OCT_INVOICE = '7442ecf1-836a-48b9-9245-b6e116a3ae84'
const HARLAND_AUG_MAIN_BILL = '9f1edb9a-9d71-4a35-a62b-a5026709f514'

// Neighbors' August back-row bills: id → [unit, old, new, paid?]
const NEIGHBORS: { bill: string; unit: string; old: number; next: number; paid: boolean }[] = [
  { bill: '8c3b6adb-ffc2-4d3f-97c8-17c3761a1263', unit: 'RV 20', old: 18.69, next: 12.45, paid: true },
  { bill: '4f38406c-b0e6-49f1-8f76-8ff62b4cbde1', unit: 'RV 23', old: 18.70, next: 12.47, paid: false },
  { bill: '2928a80d-559e-49bb-b355-ca6f179b5b48', unit: 'RV 24', old: 18.70, next: 12.47, paid: true },
  { bill: 'e6cc7b77-71f5-41cb-bfea-3198d5458ff5', unit: 'RV 25', old: 18.70, next: 12.47, paid: false },
]
const HARLAND_SHARE = 24.93
const HARLAND_AUG_MAIN_PAID = 10.45
const HARLAND_WATER_LINE = 14.48       // 24.93 − 10.45
const RV22_AUG_ELECTRIC = 23.10        // 110 kWh × $0.21

const r2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const dry = process.env.DRY !== '0'
  // Arithmetic guards — refuse to run on numbers that don't add up.
  const split = r2(HARLAND_SHARE + NEIGHBORS.reduce((s, n) => s + n.next, 0))
  if (split !== 74.79) throw new Error(`re-split sums to ${split}, not 74.79`)
  if (r2(HARLAND_SHARE - HARLAND_AUG_MAIN_PAID) !== HARLAND_WATER_LINE) throw new Error('water line arithmetic')
  if (r2(110 * 0.21) !== RV22_AUG_ELECTRIC) throw new Error('electric arithmetic')

  const c = await getClient()
  try {
    await c.query('BEGIN')

    // ── 1. Neighbors ────────────────────────────────────────────────────
    for (const n of NEIGHBORS) {
      const b = (await c.query<any>(
        `SELECT ub.id, ub.charge_amount::float AS charge, ub.status, ub.payment_id, ub.tenant_id, ub.lease_id,
                ub.landlord_id, ub.meter_id, to_char(ub.billing_cycle_month,'YYYY-MM-DD') AS cycle,
                p.amount::float AS pay_amount, p.status AS pay_status, p.invoice_id
           FROM utility_bills ub JOIN payments p ON p.id = ub.payment_id
          WHERE ub.id = $1 FOR UPDATE OF ub, p`, [n.bill])).rows[0]
      if (!b) throw new Error(`${n.unit}: bill ${n.bill} not found`)
      if (b.meter_id !== BACK_ROW_METER || b.cycle !== '2026-08-01') throw new Error(`${n.unit}: not the August back-row bill`)
      if (b.charge !== n.old || b.pay_amount !== n.old) throw new Error(`${n.unit}: expected ${n.old}, found bill ${b.charge} / line ${b.pay_amount}`)
      const settledNow = b.pay_status === 'settled' || b.pay_status === 'paid_via_deposit'
      if (settledNow !== n.paid) throw new Error(`${n.unit}: expected ${n.paid ? 'paid' : 'unpaid'}, line is ${b.pay_status}`)
      const diff = r2(n.old - n.next)

      await c.query(
        `UPDATE utility_bills SET charge_amount = $2, notes = COALESCE(notes || ' — ', '') || $3, updated_at = NOW()
          WHERE id = $1`, [n.bill, n.next.toFixed(2), `${NEIGHBOR_NOTE} (was $${n.old.toFixed(2)})`])

      if (n.paid) {
        await c.query(
          `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, created_by)
           VALUES ($1, $2, $3, $4, $4, 'overcharge', $5, $6)`,
          [b.landlord_id, b.tenant_id, b.lease_id, diff.toFixed(2),
           `August water overcharge returned: the back-row bill was split among too few people. Your share was $${n.next.toFixed(2)}, not $${n.old.toFixed(2)}.`,
           CREATED_BY])
        console.log(`${n.unit}: paid $${n.old.toFixed(2)} → share $${n.next.toFixed(2)} → credit $${diff.toFixed(2)}`)
      } else {
        const upd = await c.query(
          `UPDATE payments SET amount = $2, notes = COALESCE(notes || ' — ', '') || $3
            WHERE id = $1 AND status IN ('pending','failed') AND stripe_payment_intent_id IS NULL`,
          [b.payment_id, n.next.toFixed(2), `${NEIGHBOR_NOTE} (was $${n.old.toFixed(2)})`])
        if (upd.rowCount !== 1) throw new Error(`${n.unit}: line ${b.payment_id} is not an untouched unpaid line (payment in flight?) — stopped`)
        const inv = (await c.query<any>(
          `UPDATE invoices SET subtotal_utilities = subtotal_utilities - $2, total_amount = total_amount - $2, updated_at = NOW()
            WHERE id = $1 AND status IN ('pending','partial')
            RETURNING subtotal_utilities::float AS su, total_amount::float AS total`, [b.invoice_id, diff.toFixed(2)])).rows[0]
        if (!inv) throw new Error(`${n.unit}: invoice ${b.invoice_id} is not open`)
        console.log(`${n.unit}: unpaid line $${n.old.toFixed(2)} → $${n.next.toFixed(2)}; invoice now utilities $${inv.su.toFixed(2)}, total $${inv.total.toFixed(2)}`)
      }
    }

    // ── 2 & 3. Harlands ─────────────────────────────────────────────────
    const lease = (await c.query<any>(
      `SELECT l.id, l.unit_id, l.landlord_id, l.status FROM leases l WHERE l.id = $1`, [HARLAND_LEASE])).rows[0]
    if (!lease || lease.status !== 'active') throw new Error('Harland lease not active')
    const inv = (await c.query<any>(
      `SELECT id, status, to_char(due_date,'YYYY-MM-DD') AS due, subtotal_utilities::float AS su, total_amount::float AS total
         FROM invoices WHERE id = $1 AND lease_id = $2 FOR UPDATE`, [HARLAND_OCT_INVOICE, HARLAND_LEASE])).rows[0]
    if (!inv || !['pending', 'partial'].includes(inv.status)) throw new Error('Harland October invoice not open')
    const already = (await c.query<any>(
      `SELECT 1 FROM utility_bills WHERE unit_id = $1 AND billing_cycle_month = '2026-08-01' AND meter_id = ANY($2::uuid[])`,
      [RV22_UNIT, [BACK_ROW_METER, RV22_ELECTRIC_METER]])).rows
    if (already.length) throw new Error('RV 22 August bills already exist — already applied?')
    const mainAug = (await c.query<any>(
      `SELECT ub.charge_amount::float AS charge, p.status FROM utility_bills ub JOIN payments p ON p.id = ub.payment_id
        WHERE ub.id = $1 AND ub.lease_id = $2 AND ub.billing_cycle_month = '2026-08-01'`, [HARLAND_AUG_MAIN_BILL, HARLAND_LEASE])).rows[0]
    if (!mainAug || mainAug.charge !== HARLAND_AUG_MAIN_PAID || mainAug.status !== 'settled') throw new Error('Harland August apartment water not as expected')

    async function addLine(meter: string, utilityType: 'water' | 'electric', billFields: Record<string, any>,
                           billAmount: number, lineAmount: number, lineNote: string, billNote: string) {
      const bill = (await c.query<{ id: string }>(
        `INSERT INTO utility_bills
           (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, usage_amount,
            allocation_method, allocation_basis, rate_per_unit, base_fee_share, charge_amount, status, billed_at,
            notes, tax_rate_pct, tax_amount, utility_type, reading_start, reading_end, reading_start_date, reading_end_date)
         VALUES ($1,$2,$3,$4,$5,'2026-08-01',$6,$7,$8,$9,0,$10,'billed',NOW(),$11,0,0,$12,$13,$14,$15,$16)
         RETURNING id`,
        [meter, RV22_UNIT, HARLAND_TENANT, HARLAND_LEASE, lease.landlord_id, billFields.usage ?? null,
         billFields.allocationMethod ?? null, billFields.allocationBasis ?? null, billFields.rate ?? null,
         billAmount.toFixed(2), billNote, utilityType, billFields.readingStart ?? null, billFields.readingEnd ?? null,
         billFields.readingStartDate ?? null, billFields.readingEndDate ?? null])).rows[0]
      const pay = (await c.query<{ id: string }>(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes)
         VALUES ($1,$2,$3,$4,$5,'utility',$6,'pending',$7,'UTILITY',$8) RETURNING id`,
        [HARLAND_OCT_INVOICE, lease.unit_id, HARLAND_LEASE, HARLAND_TENANT, lease.landlord_id,
         lineAmount.toFixed(2), inv.due, lineNote])).rows[0]
      await c.query(`UPDATE utility_bills SET payment_id = $2 WHERE id = $1`, [bill.id, pay.id])
      return { bill: bill.id, payment: pay.id }
    }

    const water = await addLine(BACK_ROW_METER, 'water',
      { allocationMethod: 'occupant_count', allocationBasis: 2, rate: 0.018744, readingEndDate: '2026-08-31' },
      HARLAND_SHARE, HARLAND_WATER_LINE,
      'Water — RV 22, Aug 2026 (your back-row share $24.93, less the $10.45 apartment water already charged for August)',
      `${HARLAND_NOTE}. The $10.45 you already paid as August apartment water counts toward it, so the October line is the $14.48 difference.`)
    const elec = await addLine(RV22_ELECTRIC_METER, 'electric',
      { allocationMethod: 'submeter', usage: 110, rate: 0.21, readingStart: 10966, readingEnd: 11076, readingStartDate: '2026-08-01', readingEndDate: '2026-08-31' },
      RV22_AUG_ELECTRIC, RV22_AUG_ELECTRIC,
      'Electric — RV 22, Aug 2026 (10,966 → 11,076 · 110 kWh)',
      'Added 10/3: you were at RV 22 through Aug 31; this usage was never billed.')
    const mainMeter = (await c.query<any>(`SELECT meter_id FROM utility_bills WHERE id = $1`, [HARLAND_AUG_MAIN_BILL])).rows[0].meter_id
    const mainBefore = Number((await c.query<any>(
      `SELECT SUM(charge_amount)::float AS s FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = '2026-08-01' AND status <> 'void'`,
      [mainMeter])).rows[0].s)
    const zeroed = await c.query(
      `UPDATE utility_bills SET charge_amount = 0, updated_at = NOW(),
              notes = COALESCE(notes || ' — ', '') || 'Corrected 10/3 (was $10.45): you were at RV 22 in August; the $10.45 you paid counts toward your RV 22 back-row share'
        WHERE id = $1 AND charge_amount = 10.45 RETURNING id`, [HARLAND_AUG_MAIN_BILL])
    if (zeroed.rowCount !== 1) throw new Error('Harland August apartment water bill not as expected')
    const mainAfter = Number((await c.query<any>(
      `SELECT SUM(charge_amount)::float AS s FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = '2026-08-01' AND status <> 'void'`,
      [mainMeter])).rows[0].s)
    if (r2(mainBefore - mainAfter) !== HARLAND_AUG_MAIN_PAID) throw new Error('apartment master August did not drop by exactly $10.45')
    console.log(`Apartment (Main) master August bills: $${mainBefore.toFixed(2)} → $${mainAfter.toFixed(2)} (the park covers the $10.45)`)
    const add = r2(HARLAND_WATER_LINE + RV22_AUG_ELECTRIC)
    const after = (await c.query<any>(
      `UPDATE invoices SET subtotal_utilities = subtotal_utilities + $2, total_amount = total_amount + $2, updated_at = NOW()
        WHERE id = $1 RETURNING subtotal_utilities::float AS su, total_amount::float AS total`,
      [HARLAND_OCT_INVOICE, add.toFixed(2)])).rows[0]
    console.log(`Harlands: + water $${HARLAND_WATER_LINE.toFixed(2)} (bill ${water.bill}) + electric $${RV22_AUG_ELECTRIC.toFixed(2)} (bill ${elec.bill})`)
    console.log(`Harlands' October invoice: utilities $${inv.su.toFixed(2)} → $${after.su.toFixed(2)}, total $${inv.total.toFixed(2)} → $${after.total.toFixed(2)}`)

    // The back-row August split now sums to the bill.
    const sum = (await c.query<any>(
      `SELECT SUM(charge_amount)::float AS s FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = '2026-08-01' AND status <> 'void'`,
      [BACK_ROW_METER])).rows[0].s
    console.log(`Back-row August bills now total $${Number(sum).toFixed(2)} (provider bill $74.79)`)
    if (r2(Number(sum)) !== 74.79) throw new Error('back-row August bills do not sum to $74.79')

    if (dry) { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back, nothing changed.') }
    else { await c.query('COMMIT'); console.log('Applied.') }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
