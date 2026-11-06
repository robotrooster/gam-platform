/**
 * S656 (2026-11-01) — repair the November 1 billing run at three parks.
 *
 * The 7am run billed 9 of 12 households at Country Acres a trailer payment and
 * nothing else, skipped 16 of 24 occupied spots at Oak Park, and billed a
 * resident who had already left Mountain View. Three unrelated causes, all of
 * them real:
 *
 *   COUNTRY ACRES — Lot 21's new water meter read 6, below the old meter's
 *     5901, so the read was flagged and the reading round could not close.
 *     Country Acres reviews its water before billing, so an unapproved round
 *     holds every invoice on the property WHOLE — rent included. One meter on
 *     one lot held all twelve households. Nic: "we're not going to have Blue
 *     go ahead and sign off. Just consider it signed off and rerun now."
 *     Lot 21: "bill them the water the same usage as last month, and then the
 *     meter was replaced, so mark it replaced and have that number six on the
 *     odometer as the baseline for going forward."
 *
 *   OAK PARK — the 16 spots on the two RUBS masters held because the water
 *     company's master bill had not arrived, so nobody's share could be
 *     computed. Nic entered both masters this morning and the round closed at
 *     09:37, which wrote the October water bills; they now need an invoice to
 *     ride. Lots 4, 6 and 8 are ABSENTEE — leases on spots used as a vacation
 *     home, almost never occupied. Nic: "There are people that have leases
 *     that pay for the spot that are absentee... I thought we established a
 *     flag to mark those." There is one, and it was never set on these three:
 *     "Works, nobody using it" (markMeterWorksNoUse). Lot 6's 46 is a typo —
 *     "it's still supposed to match the 4600."
 *
 *   MOUNTAIN VIEW — Tyler Schroeder left a month ago and was never checked
 *     out, so at 7am he was still a current resident with no end date and the
 *     run billed him November. Nic ended the lease at 09:40, but ending a
 *     lease does not pull a bill already issued. Nic: "I am telling you to
 *     delete the bill... the $18.48 needs to be considered wash, and whatever
 *     the meter read for that spot is now is our new baseline going forward."
 *     A bill nobody owes is VOIDED, never deleted (CLAUDE.md keep-everything,
 *     services/chargeVoids): the rows stay on record, owed by nobody, at $0.
 *
 * Every write is scoped to a named company. Country Acres belongs to another
 * operator (TruBlu) and is touched here only for the lots named above.
 *
 * DRY=1 prints the plan and rolls back. Run from apps/api:
 *   DRY=1 node -r ts-node/register src/scripts/nov1_billing_repair.ts
 */
import { getClient, query } from '../db'
import { lockHousehold } from '../services/moneyPredicates'
import { voidUnowedCharges } from '../services/chargeVoids'
import { markMeterRepaired, markMeterWorksNoUse } from '../services/meterRepair'
import { completeReadingRun } from '../services/utilityReadingRuns'
import { backfillInvoices } from '../jobs/invoiceGeneration'

// ── Who, where ──────────────────────────────────────────────────────────────
const NIC = '61c6b9ad-a52a-425a-8b9c-f78b4bf54784'            // nic@golddoor.io
const CA_LANDLORD = 'e8904104-ab16-4d02-b6f8-cac88d738aae'    // Country Acres - Mattoon
const CA_PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const OP_LANDLORD = '8d59242e-c1e5-48a7-b768-420c57fb5fca'    // Oak Park Motel and RV
const DUE = '2026-11-01'

// Country Acres Lot 21 — the replaced water meter.
const CA21_METER = '38f8341b-4dc9-4ac6-92e1-64d3a679a474'
const CA21_UNIT = (async () =>
  (await query<{ unit_id: string }>(
    `SELECT unit_id FROM utility_meter_units WHERE meter_id = $1`, [CA21_METER]))[0]?.unit_id)
const CA21_OCT_READ = '8545ebdc-409a-470d-b8bb-995ba61eb285'
const CA21_NEW_ODOMETER = 6
/** September: 5801 → 5901 = 100 turns = 10,000 gallons at $0.0165 = $165.00. */
const CA21_GALLONS = 10000
const CA21_CHARGE = 165.00
const CA_RUN = 'eaeba1ad-8be0-4a08-a8a0-74a0b4eff7dc'         // the October round

// Oak Park — absentee spots and the mistyped read.
const OP_ABSENTEE = [
  { lot: 'MH 04', meter: '5a319094-9e6c-44a4-9d13-7340b70e3425' },
  { lot: 'MH 06', meter: '2c6c658e-ff60-47c1-9f24-f2c695b9e54d' },
  { lot: 'MH 08', meter: '3771315b-fc2e-41d5-92cd-3bed3bf6a6fd' },
]
const OP06_OCT_READ = 'c67777d2-c3f1-4620-b6e5-cdc0a2603bac'
const OP06_CORRECT = 4600

// Mountain View — Tyler Schroeder, RV 20.
const TS_INVOICE = '1560482d-fbf3-4297-8cfd-fd623e6e5cbc'
const TS_LINES = ['334b0143-eead-41ee-9feb-afbc10143692', '6a2db2c1-2063-48ba-aba2-6747314b3ce3']
const TS_UTILBILL = '4667e045-52e2-4dd0-a119-abb7f12ae06c'
const TS_ELEC_METER = '8b135992-a880-4e6a-a64e-5de0546f0f21'
const TS_NEW_BASELINE = 38013   // what RV 20's electric reads now (10/31)
const TS_VOID = 'Left the spot before November — moved out, nothing owed for the month'

const money = (n: number) => `$${n.toFixed(2)}`

;(async () => {
  const dry = process.env.DRY === '1'
  console.log(dry ? '── DRY RUN — nothing will be kept ──\n' : '── APPLYING ──\n')

  // ════════════════════════════════════════════════════════════════════════
  // 1. Tyler Schroeder — delete the bill, and leave the spot a baseline.
  // ════════════════════════════════════════════════════════════════════════
  {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const inv = (await c.query<{ tenant_id: string; landlord_id: string; total_amount: string; unit_id: string }>(
        `SELECT tenant_id, landlord_id, total_amount::text, unit_id FROM invoices WHERE id = $1`,
        [TS_INVOICE])).rows[0]
      if (!inv) throw new Error('Tyler: invoice not found')
      await lockHousehold(c, inv.tenant_id, inv.landlord_id)

      const q = (text: string, params?: any[]) => c.query(text, params)
      const { voided, held } = await voidUnowedCharges(q, TS_LINES, TS_VOID)
      console.log(`1. Tyler Schroeder, Mountain View RV 20 — bill was ${money(Number(inv.total_amount))}`)
      for (const v of voided) console.log(`     voided ${v.type} ${money(v.amount)}`)
      if (held.length) console.log(`     !! ${held.length} line(s) another record points at — left owed:`, held)

      // The electric that rode it is a wash: the usage is real, nobody is
      // billed for it. Voided, not deleted, so the gallons stay on record.
      // A voided bill lets go of its charge row (utility_bills_voided_is_stamped
      // requires payment_id IS NULL): the charge is voided above, and the bill
      // keeps the gallons and the readings without pointing at money.
      const ub = await c.query(
        `UPDATE utility_bills
            SET status = 'void', voided_at = NOW(), void_reason = $2, payment_id = NULL,
                notes = LEFT(CONCAT_WS(' — ', NULLIF(notes, ''), $2::text), 2000), updated_at = NOW()
          WHERE id = $1 AND voided_at IS NULL
          RETURNING (charge_amount + COALESCE(tax_amount, 0))::text AS amt`,
        [TS_UTILBILL, 'Washed — resident had already left; not billed to anyone'])
      if (ub.rowCount) console.log(`     electric ${money(Number(ub.rows[0].amt))} washed`)

      await c.query(`SELECT fn_invoice_status_rollup_single($1::uuid)`, [TS_INVOICE])

      // The bill itself: void, $0, and it gives the lease's due date back so
      // the month could be billed again if that were ever right.
      const killed = await c.query(
        `UPDATE invoices i
            SET status = 'void', total_amount = 0, updated_at = NOW(),
                voided_from_lease_id = COALESCE(i.voided_from_lease_id, i.lease_id), lease_id = NULL,
                notes = LEFT(CONCAT_WS(E'\n', NULLIF(i.notes, ''), $2::text), 2000)
          WHERE i.id = $1 AND i.status <> 'void'
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status <> 'voided')
          RETURNING invoice_number`,
        [TS_INVOICE, TS_VOID])
      console.log(killed.rowCount
        ? `     bill ${killed.rows[0].invoice_number} is void at $0`
        : `     !! bill NOT voided — a live line remains on it`)

      // "whatever the meter read for that spot is now is our new baseline":
      // the spot starts from here for whoever takes it next, so the gap
      // between his last read and their first is billed to nobody.
      const base = await c.query(
        `INSERT INTO utility_meter_readings
           (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id, review_note)
         SELECT $1, $2::date, $3, date_trunc('month', $2::date)::date, 'baseline', $4,
                'New baseline for the spot — Tyler Schroeder moved out; his last cycle was washed'
          WHERE NOT EXISTS (
            SELECT 1 FROM utility_meter_readings
             WHERE meter_id = $1 AND reason = 'baseline' AND reading_date = $2::date)
         RETURNING reading_value`,
        [TS_ELEC_METER, DUE, TS_NEW_BASELINE, NIC])
      console.log(base.rowCount
        ? `     RV 20 electric baselined at ${TS_NEW_BASELINE} going forward`
        : `     RV 20 electric already had a baseline on ${DUE} — left alone`)

      if (dry) { await c.query('ROLLBACK'); console.log('     (rolled back)\n') }
      else { await c.query('COMMIT'); console.log('') }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
    finally { c.release() }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. Country Acres Lot 21 — the meter was replaced; bill last month's usage.
  // ════════════════════════════════════════════════════════════════════════
  {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const unitId = await CA21_UNIT()
      if (!unitId) throw new Error('Lot 21: meter serves no unit')

      // The flag came from a feature turned off on 10/31 (the fat-finger
      // flag): the read is simply the new meter's first number, and it must
      // stop holding the park.
      const unflag = await c.query(
        `UPDATE utility_meter_readings
            SET needs_review = FALSE,
                review_note = 'Meter was replaced — 6 is the new meter''s odometer, not a rollback. Baselined 11/1; October billed at September''s usage.'
          WHERE id = $1 AND needs_review
          RETURNING reading_value`, [CA21_OCT_READ])
      console.log(`2. Country Acres Lot 21 — water meter replaced`)
      console.log(unflag.rowCount ? `     flag cleared on the read of 6` : `     read was not flagged`)

      // Back in service with 6 as the starting point for the next cycle.
      await markMeterRepaired(c, { meterId: CA21_METER, startingReading: CA21_NEW_ODOMETER, userId: NIC })
      console.log(`     odometer ${CA21_NEW_ODOMETER} recorded as the baseline going forward`)

      // October cannot be measured across two different meters, so it bills at
      // September's usage on Nic's instruction. Explicit, and said on the row.
      const bill = await c.query(
        `INSERT INTO utility_bills
           (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
            utility_type, usage_amount, allocation_method, rate_per_unit,
            base_fee_share, charge_amount, tax_amount, status, notes,
            reading_start, reading_end, reading_start_date, reading_end_date)
         SELECT $1, $2, lt.tenant_id, l.id, $3, '2026-10-01'::date,
                'water', $4, 'submeter', m.rate_per_unit,
                0, $5, 0, 'unbilled',
                'Meter replaced — October billed at September''s usage (10,000 gal), the same as last month',
                5901, NULL, '2026-09-30'::date, '2026-10-28'::date
           FROM utility_meters m
           JOIN leases l ON l.unit_id = $2 AND l.status = 'active'
           JOIN lease_tenants lt ON lt.lease_id = l.id
          WHERE m.id = $1
         ON CONFLICT (meter_id, unit_id, billing_cycle_month, utility_type)
           WHERE voided_at IS NULL
           DO UPDATE SET usage_amount = EXCLUDED.usage_amount,
                         charge_amount = EXCLUDED.charge_amount,
                         notes = EXCLUDED.notes, updated_at = NOW()
         RETURNING usage_amount::text AS u, charge_amount::text AS amt`,
        [CA21_METER, unitId, CA_LANDLORD, CA_GALLONS_STR(), CA21_CHARGE.toFixed(2)])
      if (bill.rowCount) console.log(`     October water: ${Number(bill.rows[0].u)} gal, ${money(Number(bill.rows[0].amt))}`)

      if (dry) { await c.query('ROLLBACK'); console.log('     (rolled back)\n') }
      else { await c.query('COMMIT'); console.log('') }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
    finally { c.release() }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3. Oak Park — the absentee flag, and lot 6's mistyped read.
  // ════════════════════════════════════════════════════════════════════════
  {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      console.log(`3. Oak Park — absentee spots`)
      const fix = await c.query(
        `UPDATE utility_meter_readings
            SET reading_value = $2,
                review_note = 'Corrected 11/1 — 46 was a mistyped read; the meter still reads 4600',
                needs_review = FALSE
          WHERE id = $1 AND reading_value <> $2
          RETURNING reading_value`, [OP06_OCT_READ, OP06_CORRECT])
      console.log(fix.rowCount ? `     Lot 6 October read corrected 46 → ${OP06_CORRECT}` : `     Lot 6 already reads ${OP06_CORRECT}`)

      for (const a of OP_ABSENTEE) {
        await markMeterWorksNoUse(c, { meterId: a.meter, userId: NIC })
        console.log(`     ${a.lot}: meter works, nobody using it — zero reads bill $0, no more flags or estimates`)
      }

      if (dry) { await c.query('ROLLBACK'); console.log('     (rolled back)\n') }
      else { await c.query('COMMIT'); console.log('') }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
    finally { c.release() }
  }

  if (dry) {
    console.log('── DRY RUN: stopping before the reading round and the reruns, which cannot be rolled back piecemeal ──')
    process.exit(0)
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4. Country Acres — consider it signed off, and issue October's water.
  // ════════════════════════════════════════════════════════════════════════
  console.log(`4. Country Acres — signing off the October round on Nic's instruction`)
  const run = await completeReadingRun(CA_RUN, NIC, { approve: true })
  console.log(`     round is ${run?.status}; ${run?.bills_created ?? 0} bills created, ${money(Number(run?.billed_total ?? 0))} issued\n`)

  // ════════════════════════════════════════════════════════════════════════
  // 5. Rerun the 1st. Idempotent — a household already billed is skipped.
  // ════════════════════════════════════════════════════════════════════════
  for (const [name, landlordId] of [['Country Acres', CA_LANDLORD], ['Oak Park', OP_LANDLORD]] as const) {
    const r = await backfillInvoices({ from: DUE, to: DUE, landlordId })
    console.log(`5. ${name} rerun: ${r.invoicesInserted} invoices, ${r.rentsInserted} rent lines, `
      + `${r.utilitiesInserted} utility lines, ${r.feesInserted} fees`)
  }
  console.log('')

  // ════════════════════════════════════════════════════════════════════════
  // 6. What every household is now billed.
  // ════════════════════════════════════════════════════════════════════════
  const out = await query<any>(
    `SELECT p.name AS park, u.unit_number AS lot, l.rent_amount::text AS rent,
            COALESCE(i.invoice_number, 'STILL NOTHING') AS inv,
            COALESCE(i.subtotal_rent::text, '-') AS r,
            COALESCE(i.subtotal_utilities::text, '-') AS w,
            COALESCE(i.subtotal_home_payments::text, '-') AS h,
            COALESCE(i.total_amount::text, '-') AS tot
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN invoices i ON i.lease_id = l.id AND i.due_date = $1::date AND i.status <> 'void'
      WHERE l.status = 'active' AND p.landlord_id = ANY($2::uuid[])
      ORDER BY p.name, (i.id IS NULL) DESC, lpad(regexp_replace(u.unit_number, '\\D', '', 'g'), 6, '0')`,
    [DUE, [CA_LANDLORD, OP_LANDLORD]])
  console.log('6. Every household at both parks:')
  console.log('   park / lot / rent / invoice / rent / utilities / home pmt / TOTAL')
  for (const r of out) {
    console.log(`   ${r.park} ${r.lot} (rent ${r.rent}) → ${r.inv}  rent ${r.r}  util ${r.w}  home ${r.h}  TOTAL ${r.tot}`)
  }
  const missing = out.filter((r: any) => r.inv === 'STILL NOTHING')
  console.log(`\n   ${out.length - missing.length} of ${out.length} billed.`)
  if (missing.length) console.log(`   !! still unbilled: ${missing.map((m: any) => `${m.park} ${m.lot}`).join(', ')}`)
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })

/** 10,000 gallons, as a numeric string for the bill row. */
function CA_GALLONS_STR(): string { return CA21_GALLONS.toFixed(4) }
