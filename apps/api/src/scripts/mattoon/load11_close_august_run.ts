import { completeReadingRun } from '../../services/utilityReadingRuns'
import { queryOne } from '../../db'
;(async () => {
  const owner = await queryOne<any>(`SELECT l.user_id FROM properties p JOIN landlords l ON l.id=p.landlord_id WHERE p.name='Country Acres - Mattoon'`)
  const r = await completeReadingRun('6ca28c4f-8d00-4341-92e5-e8677eb4986f', owner.user_id, { approve: true })
  console.log(r.status, 'bills', r.bills_created, 'total', r.billed_total)
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
