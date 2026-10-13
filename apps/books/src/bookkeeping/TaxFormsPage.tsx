/**
 * 10/12 (Nic): the tax forms page (W-2s, 1099-NECs, 940, 941 and the states'
 * forms) — not built yet; it says so.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts).
 */
import { ComingSoon } from './common'

export function TaxFormsPage(){
  return <ComingSoon title="Tax Forms" icon="📋" description="W-2s, 1099-NECs, 940, 941, state-specific forms"/>
}
