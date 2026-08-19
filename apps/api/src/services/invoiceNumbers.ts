// Invoice number allocation — one definition (S605).
//
// This existed as two byte-identical private copies, in jobs/invoiceGeneration.ts
// and jobs/moveInBundle.ts. Adding a third for carried balances would have made
// the drift risk real: invoice numbers are per-landlord, per-year, and gapless,
// so three independent implementations of the same sequence bump is exactly the
// shape of bug that shows up as duplicate invoice numbers months later.
import type { PoolClient } from 'pg'
import { formatInvoiceNumber } from '@gam/shared'

/**
 * Allocate the next invoice number for a landlord in a given year.
 *
 * The sequence is bumped by the INSERT ... ON CONFLICT DO UPDATE itself, so the
 * row lock Postgres takes on the conflicting row serializes concurrent callers —
 * two invoices cut at the same instant get different numbers without an explicit
 * advisory lock. Must be called inside the caller's transaction so a rolled-back
 * invoice doesn't consume a number.
 */
export async function allocateInvoiceNumber(
  client: PoolClient,
  landlordId: string,
  year: number,
): Promise<string> {
  const r = await client.query(
    `INSERT INTO invoice_sequences (landlord_id, year, next_number)
     VALUES ($1, $2, 2)
     ON CONFLICT (landlord_id, year)
     DO UPDATE SET next_number = invoice_sequences.next_number + 1
     RETURNING next_number`,
    [landlordId, year],
  )
  const nextAfter = r.rows[0].next_number as number
  return formatInvoiceNumber(year, nextAfter - 1)
}
