import { useState } from 'react'
import { AuthedImg } from './AuthedMedia'
import { sendDepositPhoto } from './RecordPaymentWindow'
import { depositPhotoProblem } from '../lib/creditDesk'
import { toast } from './dialogs'

/**
 * 10/5 (Nic): a bank deposit's photo of the bank's receipt — shown here in the
 * app (the file sits behind the authed route, so it is fetched with the sign-in
 * and shown from memory; never a new tab, which Safari blocks after a fetch), or
 * added when it was not sent with the payment. Clicks stay in the cell (the row
 * itself opens its charges).
 */
export function BankReceiptPhoto({ receiptId, url, canAdd, onAdded, label = 'Bank receipt photo' }: {
  receiptId: string | null | undefined; url: string | null | undefined; canAdd: boolean; onAdded: () => void
  /** 10/5: what the button and the window are called ("Tenant's photo of the bank receipt"). */
  label?: string
}) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  if (url) {
    return (
      <div className="cd-ledger-sub" onClick={e => e.stopPropagation()}>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>{label}</button>
        {open && (
          <div className="modal-overlay" onClick={() => setOpen(false)}>
            <div className="modal cd-window" onClick={e => e.stopPropagation()}>
              <div className="cd-head">
                <div className="modal-title cd-title">{label}</div>
              </div>
              <div className="cd-window-body">
                <AuthedImg path={url} alt="Photo of the bank's deposit receipt"
                  style={{ display: 'block', width: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: 8 }} />
              </div>
              <div className="cd-actions cd-footer">
                <button type="button" className="btn btn-ghost cd-grow" onClick={() => setOpen(false)}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
  if (!receiptId || !canAdd) return null
  return (
    <div className="cd-ledger-sub" onClick={e => e.stopPropagation()}>
      <label className={`btn btn-primary btn-sm${busy ? ' disabled' : ''}`} style={{ cursor: busy ? 'default' : 'pointer' }}
        aria-disabled={busy}>
        {busy ? 'Adding the photo…' : 'Add a photo of the bank\'s receipt'}
        <input type="file" accept="image/*" style={{ display: 'none' }} disabled={busy}
          onChange={async e => {
            const f = e.target.files?.[0] ?? null
            e.target.value = ''
            const problem = depositPhotoProblem(f)
            if (problem) { toast.error(problem); return }
            if (!f) return
            setBusy(true)
            const note = await sendDepositPhoto(receiptId, f)
            setBusy(false)
            if (note) toast.error('The photo did not upload. Try again.')
            else onAdded()
          }} />
      </label>
    </div>
  )
}

