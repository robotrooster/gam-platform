/** 10/29 — read-only: what the FlexDeposit prompt says for the DEMO resident. */
import { db } from '../db'
import { flexDepositOffer, getFlexDepositEligibility } from '../services/flexDeposit'
const TENANT = 'a24e0f5b-c75c-4499-85d3-0ec354c22d77'
;(async () => {
  const n = await db.query<{ d: string }>(`SELECT current_database() AS d`)
  if (n.rows[0].d !== 'gam_demo') throw new Error(`wrong db: ${n.rows[0].d}`)
  console.log('ELIGIBILITY', JSON.stringify(await getFlexDepositEligibility(TENANT), null, 2))
  console.log('OFFER', JSON.stringify(await flexDepositOffer({ tenantId: TENANT }), null, 2))
  await db.end()
})().catch(e => { console.error(e); process.exit(1) })
