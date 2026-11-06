/** 10/29 — read-only: the demo resident's due-at-move-in figures. */
import { db } from '../db'
import { flexDepositOffer } from '../services/flexDeposit'
;(async () => {
  const n = await db.query<{ d: string }>(`SELECT current_database() AS d`)
  if (n.rows[0].d !== 'gam_demo') throw new Error('wrong db')
  const o = await flexDepositOffer({ tenantId: 'a24e0f5b-c75c-4499-85d3-0ec354c22d77' })
  console.log('otherDueNow:', o?.otherDueNow)
  for (const c of o?.choices ?? []) {
    console.log(`${c.payments} payments → due at move-in $${(o!.otherDueNow + c.firstPull).toFixed(2)}`)
  }
  await db.end()
})().catch(e => { console.error(e); process.exit(1) })
