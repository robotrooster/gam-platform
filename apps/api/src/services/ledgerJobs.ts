/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE TWO SCHEDULED JOBS
 *
 *   Nic: "within a minute (+ nightly tie-out check)"
 *
 *   every minute  drain the outbox: post what money changed (one runner at a
 *                 time across processes; a slow pass makes the next one skip)
 *   04:40 nightly the tie-out (services/ledgerCheck): per company, drain, check
 *                 everything in one snapshot, re-post drift from source, tell
 *                 an admin
 *   05:10 nightly 10/12 (ledger P8): the parity check (services/ledgerParity):
 *                 the ledger against the money records, last month and this
 *                 month, an admin told of any difference
 *
 * Both run the production projector set (services/ledgerProjectors). In this
 * phase it is empty, so the drain returns at once and the check finds no
 * company with ledger activity — the ledger is dark until the projector
 * phases ship.
 */
import cron from 'node-cron'
import { logger } from '../lib/logger'
import { registerProductionLedgerProjectors } from './ledgerProjectors'

let draining = false

export function registerLedgerJobs(): void {
  registerProductionLedgerProjectors()
  cron.schedule('* * * * *', async () => {
    if (draining) return
    draining = true
    try {
      // 10/12 (Nic, ledger P6): a month of a fixed asset's depreciation posts
      // once the month is over — mark each one that just ended (on the books'
      // own pool), then drain as usual. A failure here never stops the drain.
      try {
        const [{ markDepreciationMonthsDue }, { ledgerDb }] = await Promise.all([import('./booksVendorsLoans'), import('../db/ledgerPool')])
        await markDepreciationMonthsDue(ledgerDb)
      } catch (e) {
        logger.error({ err: e }, '[ledger-drain] could not mark depreciation months due')
      }
      const { drainLedgerOutbox } = await import('./ledgerEngine')
      const r = await drainLedgerOutbox()
      if (r.keys > 0) logger.info(r, '[ledger-drain]')
    } catch (e) {
      logger.error({ err: e }, '[ledger-drain] fatal')
    } finally {
      draining = false
    }
  })
  cron.schedule('40 4 * * *', async () => {
    try {
      const { runLedgerChecks } = await import('./ledgerCheck')
      const results = await runLedgerChecks({ owner: 'all' })
      if (results.length) logger.info({ companies: results.length }, '[ledger-check] nightly tie-out done')
    } catch (e) {
      logger.error({ err: e }, '[ledger-check] fatal')
    }
  }, { timezone: 'America/Phoenix' })
  // 10/12 (Nic, ledger P8): the nightly parity check, after the tie-out — the
  // ledger against the money records for last month and this month, to the
  // cent (the processing fees included), an admin told of any difference
  // (services/ledgerParity).
  cron.schedule('10 5 * * *', async () => {
    try {
      const { runLedgerParity } = await import('./ledgerParity')
      const results = await runLedgerParity()
      if (results.length) logger.info({ companies: results.length, differing: results.filter(r => r.differences > 0).length }, '[ledger-parity] nightly check done')
    } catch (e) {
      logger.error({ err: e }, '[ledger-parity] fatal')
    }
  }, { timezone: 'America/Phoenix' })
}
