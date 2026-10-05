/**
 * S655 money plan, Step 3 / P10 — READ-ONLY. Run at deploy AFTER the
 * migrations (P1) and the history backfill (P2), before and after the code goes
 * live, to see every landlord's September and October both ways against the old
 * single definition.
 *
 *   node -r ts-node/register src/scripts/oct3_reports_before_after.ts
 *   MONTHS=2026-09,2026-10 node -r ts-node/register src/scripts/oct3_reports_before_after.ts
 *
 * It cannot write: every statement runs as BEGIN READ ONLY … ROLLBACK, and
 * the script refuses to start unless the database reports read-only, so even
 * a bug here can change nothing.
 *
 * For each landlord with a property, per month:
 *   before    — the old P&L income: settled landlord rows by settle instant
 *               (GAM's home calendar) plus other income, every dollar of the
 *               row whatever paid it
 *   received  — "Money received": money on the day it arrived (property day);
 *               paid-ahead money the day it arrived and $0 when used; a credit
 *               the landlord gave never income; register sales and stays
 *   billed    — "Money billed": bills by due date, with collected so far /
 *               clearing / still owed, credits given taken off
 * and the lines that make up the difference.
 *
 * Expected differences under Money received (money plan §5 P10, owner
 * correction 10/2). The script computes each one from the data AS OF THE RUN
 * and prints it, rather than this header naming amounts that keep moving
 * (register sales are still being rung up every day):
 *   - credit the landlord gave comes off (Oak Park September: Kim's $450
 *     move-in special);
 *   - paid-ahead money counts the day it ARRIVED and $0 when it pays a later
 *     bill (Todd's $920 check is all September, October $0 from him; Glenda's
 *     posted check counts Sept 22; Russ's $37.60 counts Aug 12, outside these
 *     months, and $0 on Oct 1);
 *   - register sales, stays and pay links join, net of tax and card fee
 *     (Mountain View);
 *   - Square other income joins once P8 files it (Mountain View), in both the
 *     old figure and the new one.
 * Under Money billed it is a due-date view — unpaid bills join and credits
 * given come off — so it is not compared with the old figure.
 *
 * "left to explain" is the difference those printed parts do not cover. A
 * figure other than $0.00 there needs its reason found in the lines printed
 * above it (a deposit return, a dispute, a payment settled near midnight at a
 * property whose calendar day differs from Phoenix's) before the deploy review
 * goes on.
 */

async function main() {
  const { db, query } = await import('../db')
  // Every statement this script (and the report code it calls) sends runs as
  // BEGIN READ ONLY … ROLLBACK on its own connection: a write is refused by
  // the database, and nothing could be committed even if it were not.
  const connect = db.connect.bind(db)
  ;(db as any).query = async (text: any, params?: any) => {
    const c = await connect()
    try {
      await c.query('BEGIN READ ONLY')
      const r = await c.query(text, params)
      await c.query('ROLLBACK')
      return r
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    } finally { c.release() }
  }
  const { incomeTotals, lineList } = await import('../services/incomeBasis')

  const months = (process.env.MONTHS ?? '2026-09,2026-10').split(',').map(s => s.trim()).filter(Boolean)
  for (const m of months) if (!/^\d{4}-\d{2}$/.test(m)) throw new Error(`MONTHS: "${m}" is not YYYY-MM`)

  const ro = await query<{ ro: string }>(`SELECT current_setting('transaction_read_only') AS ro`)
  if (ro[0]?.ro !== 'on') throw new Error('Refusing to run: the connection is not read-only')

  const landlords = await query<{ id: string; name: string }>(
    `SELECT l.id, COALESCE(l.business_name, u.first_name || ' ' || u.last_name) AS name
       FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE EXISTS (SELECT 1 FROM properties p WHERE p.landlord_id = l.id)
      ORDER BY 2`)

  const money = (n: number) => (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2)
  let anyDiff = 0
  for (const l of landlords) {
    for (const ym of months) {
      const [y, mo] = ym.split('-').map(Number)
      const first = `${ym}-01`
      const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)
      // The old definition (S654 computeLandlordPL), reproduced here so the
      // comparison does not depend on code that no longer exists.
      const old = await query<{ t: string }>(
        `SELECT (COALESCE((SELECT SUM(p.amount) FROM payments p
                            WHERE p.landlord_id = $1 AND p.status = 'settled'
                              AND p.revenue_owner = 'landlord'
                              AND p.type IN ('rent','late_fee','fee','utility','home_payment','carried_balance')
                              AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
                              AND p.settled_at >= ($2::date::timestamp AT TIME ZONE 'America/Phoenix')
                              AND p.settled_at <  (($3::date + 1)::timestamp AT TIME ZONE 'America/Phoenix')), 0)
               + COALESCE((SELECT SUM(amount) FROM landlord_other_income
                            WHERE landlord_id = $1 AND status = 'active'
                              AND income_date BETWEEN $2::date AND $3::date), 0))::text AS t`,
        [l.id, first, last])
      const before = Math.round(Number(old[0]?.t ?? 0) * 100) / 100
      // What the old figure counted that the new one does not: the parts of
      // those same settled rows paid by credit the landlord gave or by money
      // paid ahead (it counted the day it arrived).
      const creditPaid = await query<{ issued: string; paid_ahead: string }>(
        `SELECT COALESCE(SUM(p.issued_credit_amount), 0)::text AS issued,
                COALESCE(SUM(vm.paid_ahead_credit), 0)::text AS paid_ahead
           FROM payments p
           JOIN v_payment_money vm ON vm.payment_id = p.id
          WHERE p.landlord_id = $1 AND p.status = 'settled'
            AND p.revenue_owner = 'landlord'
            AND p.type IN ('rent','late_fee','fee','utility','home_payment','carried_balance')
            AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
            AND p.settled_at >= ($2::date::timestamp AT TIME ZONE 'America/Phoenix')
            AND p.settled_at <  (($3::date + 1)::timestamp AT TIME ZONE 'America/Phoenix')`,
        [l.id, first, last])
      const issued = Number(creditPaid[0]?.issued ?? 0)
      const paidAheadUsed = Number(creditPaid[0]?.paid_ahead ?? 0)
      const rx = await incomeTotals({ landlordIds: [l.id], start: first, end: last, basis: 'received' })
      const bx = await incomeTotals({ landlordIds: [l.id], start: first, end: last, basis: 'billed' })
      const dRx = Math.round((rx.total - before) * 100) / 100
      const explained = Math.round((rx.lines.registerAndStays + rx.lines.paidAhead - issued - paidAheadUsed) * 100) / 100
      const left = Math.round((dRx - explained) * 100) / 100
      if (left !== 0) anyDiff++
      console.log(`\n${l.name} — ${ym}`)
      console.log(`  before (old definition)  ${money(before)}`)
      console.log(`  Money received           ${money(rx.total)}   (${dRx >= 0 ? '+' : ''}${dRx.toFixed(2)} vs before)`)
      console.log(`    expected: register sales, stays and pay links ${money(rx.lines.registerAndStays)}` +
        ` · paid ahead arrived ${money(rx.lines.paidAhead)}` +
        ` · credit you gave ${money(-issued)} · paid ahead used ${money(-paidAheadUsed)}`)
      console.log(`    left to explain          ${money(left)}`)
      for (const li of lineList(rx.lines)) console.log(`      ${li.label.padEnd(36)} ${money(li.amount)}`)
      if (rx.beside.clearing) console.log(`      beside: still clearing ${money(rx.beside.clearing)}`)
      if (rx.beside.creditsYouGave) console.log(`      beside: credits you gave ${money(rx.beside.creditsYouGave)}`)
      if (rx.paidAheadUnused) console.log(`      beside: paid ahead, not used yet at ${last} ${money(rx.paidAheadUnused)}`)
      console.log(`  Money billed             ${money(bx.total)}   collected so far ${money(bx.beside.collectedSoFar)} · clearing ${money(bx.beside.clearing)} · still owed ${money(bx.beside.stillOwed)}`)
      for (const li of lineList(bx.lines)) console.log(`      ${li.label.padEnd(36)} ${money(li.amount)}`)
    }
  }
  console.log(`\nREAD-ONLY — nothing changed. ${landlords.length} landlord(s), ${months.join(', ')}; ${anyDiff} landlord-month(s) have a difference left to explain under Money received.`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
