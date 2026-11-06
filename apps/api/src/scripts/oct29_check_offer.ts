/** 10/29 — read-only: the standing FlexDeposit offer for the MH 28 resident. */
import { db } from '../db'
import { flexDepositOffer } from '../services/flexDeposit'
;(async () => {
  console.log(JSON.stringify(await flexDepositOffer({ tenantId: '20095944-006e-45d8-b653-a857770b2679' }), null, 2))
  await db.end()
})().catch(e => { console.error(e); process.exit(1) })
