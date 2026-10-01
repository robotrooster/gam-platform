/**
 * S654 — re-announce the October 1 bills that changed after their morning
 * email. Nic: "do it so they know that their bills are updated."
 * Each goes out as "Updated bill: $X due …" with a line saying it replaces the
 * morning's email. Idempotent: sent_at is cleared then re-stamped by the send.
 */
import { query } from '../db'
import { sendPendingInvoiceNotices } from '../services/invoiceNotice'

const IDS = [
  '812aa836-37d0-4295-af59-0a152af6abe3', // CA MH 01 Sheptock 757.25
  '2dcea771-5788-4df4-8f16-4d13df404ad0', // CA MH 06 Clabough 110.55
  '4c1cdecd-02de-41ac-ade4-3092f78137d1', // CA MH 18 Smith 466.50
  'bfc25fc6-e30e-435b-bb6b-ce1ca077ba59', // CA MH 21 Skinner 815.00
  '8169756e-80b3-4de2-bcff-bcf48b958256', // CA MH 22 Street 541.50
  '50d3e596-0df8-47e2-a7c8-642402642889', // CA MH 24 Whitfield 466.50
  '10da904d-78d6-4f31-a2ac-c4e5bb326be8', // CA MH 28 McCoy 689.60
  '562a4a0b-6908-4b84-9b08-295ba11c2fb9', // CA MH 29 Mitchell 678.05
  '97271a55-4a57-424e-b5f1-9cdb9df8925b', // CA MH 30 Bowman 589.60
  '8aefe0d7-3d36-47b7-a0e6-f30c3d95e3a5', // MV RV 04 Kenyon 517.47
  '1c1e3a06-43f8-421f-96bb-80c7ba8e24b7', // MV RV 33 Alvarado 631.50
  '79292d14-ccf5-417e-96d1-6d00a5a7a939', // MV RV 36 Avalos 557.37
  '06caf8ba-b071-4945-908e-feadf5dfcd45', // MV RV 44 Lane 708.49
  'fbfa5ab4-662b-4ceb-be4c-af6effdc6d99', // MV RV 49 Parker 729.70
]

;(async () => {
  let sent = 0, failed = 0, skipped = 0
  for (const id of IDS) {
    await query(`UPDATE invoices SET sent_at = NULL WHERE id = $1`, [id])
    const r = await sendPendingInvoiceNotices({ invoiceId: id, updated: true })
    sent += r.sent; failed += r.failed; skipped += r.skippedNoEmail + r.skippedCovered
    const row = await query<any>(`SELECT invoice_number, total_amount::text, sent_at FROM invoices WHERE id=$1`, [id])
    console.log(`${row[0].invoice_number} $${row[0].total_amount} sent=${r.sent} failed=${r.failed} skipped=${r.skippedNoEmail + r.skippedCovered} sent_at=${row[0].sent_at ? 'stamped' : 'NULL'}`)
  }
  console.log({ sent, failed, skipped })
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
