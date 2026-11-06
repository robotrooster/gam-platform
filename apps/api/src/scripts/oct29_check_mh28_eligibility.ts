/** 10/29 — read-only: what FlexDeposit says about the MH 28 resident today. */
import { db } from '../db'
import { getFlexDepositEligibility, isFlexDepositVisible } from '../services/flexDeposit'

const TENANT = '20095944-006e-45d8-b653-a857770b2679'

async function main() {
  console.log('product visible:', await isFlexDepositVisible())
  const e = await getFlexDepositEligibility(TENANT)
  console.log(JSON.stringify(e, null, 2))
  await db.end()
}
main().catch(e => { console.error(e); process.exit(1) })
