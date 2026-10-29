/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P7: PAYROLL AND THE BOOKKEEPER'S JOURNAL ENTRIES
 *
 * Everything phase P7 posts, for services/ledgerProjectors.ts
 * (registerProductionLedgerProjectors):
 *
 *   payroll_run      payrollRun      J3 — an approved run on its pay date
 *   manual_journal   manualJournal   J4 — a posted journal entry, as entered
 *
 * No nightly tie-out of its own: payroll liabilities and hand entries are not
 * kept by GAM from a money record the way receivables or money GAM holds are
 * (design §8), so there is nothing for a check to prove them against.
 */
import type { LedgerProjector } from '../ledgerEngine'
import { payrollRunProjector } from './payrollRun'
import { manualJournalProjector } from './manualJournal'

export const P7_LEDGER_PROJECTORS: readonly LedgerProjector[] = [
  payrollRunProjector,
  manualJournalProjector,
]
