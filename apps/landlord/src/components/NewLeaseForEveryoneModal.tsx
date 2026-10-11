import { useState } from 'react'
import { useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiPost } from '../lib/api'
import { NEW_LEASE_RENT_MODES, NEW_LEASE_RENT_MODE_LABEL, newLeaseRent, type NewLeaseRentMode } from '@gam/shared'

/**
 * S655 — the park-wide sender. Nic's direction: "new lease for every resident
 * at this property, starting <date>, rent <amount or +%>", the landlord signs
 * each in one pass.
 *
 * Fewest choices: a start date and how the rent is set. "Show who gets one"
 * lists every household with its new rent and lease form, and — where one
 * cannot go — the reason in plain words; untick anyone to leave them out.
 * Creating drafts the ticked ones and opens the first for signing; each
 * signature moves straight on to the next. The server plans it again from the
 * database at that moment, so nothing on this screen can be stale.
 *
 * Nothing is sent to a household until the landlord signs their lease.
 */

const money = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const longDate = (iso: string) => new Date(iso.slice(0, 10) + 'T12:00:00Z')
  .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** The 1st of the month after next — the usual start for a month-to-month change. */
function defaultStart(): string {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() + 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

interface Row {
  leaseId: string; unitNumber: string; tenantNames: string
  currentRent: number; newRent: number; templateName: string | null
  ok: boolean; reason: string | null
  /** A signed term that ends sooner: it holds over at today's rent until the day before. */
  note?: string | null
}
interface Made {
  created: Array<{ documentId: string; leaseId: string; unitNumber: string }>
  skipped: Array<{ leaseId: string; unitNumber: string; reason: string }>
}

export function NewLeaseForEveryoneModal({ propertyId, propertyName, onClose }: {
  propertyId: string; propertyName: string; onClose: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [startDate, setStartDate] = useState(defaultStart())
  const [rentMode, setRentMode] = useState<NewLeaseRentMode>('same')
  const [rentValue, setRentValue] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [kept, setKept] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // Some were drafted and some were left out at the moment of creating (say a
  // colleague started one a minute ago): show who and why before signing.
  const [made, setMade] = useState<Made | null>(null)

  const valueNum = rentValue.trim() === '' ? null : Number(rentValue.replace(/[$,%\s]/g, ''))
  const body = () => ({
    propertyId, startDate, rentMode,
    ...(rentMode === 'same' ? {} : { rentValue: valueNum }),
  })
  // Any change to the inputs clears the list — it must be shown again.
  const changed = (fn: () => void) => { fn(); setRows(null); setError(null); setMade(null) }

  // `refresh` re-lists after a failed create: the list shows what is true now,
  // and the message saying what went wrong stays on screen (it is cleared only
  // by changing an input or pressing a button again).
  const previewMut = useMutation(
    (_opts: { refresh?: boolean } = {}) => apiPost('/esign/documents/renewal-batch/preview', body()),
    {
      onSuccess: (r: any, opts) => {
        const list: Row[] = r?.data?.rows ?? []
        setRows(list)
        setKept(new Set(list.filter(x => x.ok).map(x => x.leaseId)))
        if (!opts?.refresh) setError(null)
      },
      onError: (e: any, opts) => {
        if (!opts?.refresh) setError(e?.response?.data?.error || 'Could not list the households. Press the button again.')
      },
    },
  )
  const goSign = (created: Made['created']) => {
    const [first, ...rest] = created.map(c => c.documentId)
    onClose()
    navigate('/sign/' + first + (rest.length ? '?queue=' + rest.join(',') : ''))
  }
  const createMut = useMutation(
    () => apiPost('/esign/documents/renewal-batch', { ...body(), leaseIds: Array.from(kept) }),
    {
      onSuccess: (r: any) => {
        const result: Made = { created: r?.data?.created ?? [], skipped: r?.data?.skipped ?? [] }
        qc.invalidateQueries('leases')
        qc.invalidateQueries('landlord-pending')
        qc.invalidateQueries('esign-docs')
        if (result.created.length === 0) {
          const why = result.skipped[0]?.reason
          setError(why ? `None could be drafted: ${why}` : 'None could be drafted. The list below shows why.')
          previewMut.mutate({ refresh: true })
          return
        }
        if (result.skipped.length > 0) { setMade(result); return }
        goSign(result.created)
      },
      onError: (e: any) => {
        setError(e?.response?.data?.error || 'Could not create the new leases. Press the button again.')
        previewMut.mutate({ refresh: true })
      },
    },
  )

  const ready = !!startDate && (rentMode === 'same' || (valueNum != null && Number.isFinite(valueNum)))
  const keptCount = rows ? rows.filter(r => r.ok && kept.has(r.leaseId)).length : 0
  const sample = rentMode === 'percent' && valueNum != null ? newLeaseRent(1000, 'percent', valueNum) : null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">New lease for everyone at {propertyName}</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <label style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
            New leases start on
            <input type="date" className="form-input" value={startDate} style={{ display: 'block', width: '100%', marginTop: 4 }}
              onChange={e => changed(() => setStartDate(e.target.value))} />
          </label>
          <label style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
            Rent
            <select className="form-select" value={rentMode} style={{ display: 'block', width: '100%', marginTop: 4 }}
              onChange={e => changed(() => { setRentMode(e.target.value as NewLeaseRentMode); setRentValue('') })}>
              {NEW_LEASE_RENT_MODES.map(m => <option key={m} value={m}>{NEW_LEASE_RENT_MODE_LABEL[m]}</option>)}
            </select>
          </label>
        </div>
        {rentMode !== 'same' && (
          <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 12 }}>
            {rentMode === 'amount' ? 'New monthly rent for every household ($)' : 'Raise each rent by (%)'}
            <input className="form-input" inputMode="decimal" value={rentValue} style={{ display: 'block', width: 180, marginTop: 4 }}
              placeholder={rentMode === 'amount' ? 'e.g. 650' : 'e.g. 5'}
              onChange={e => changed(() => setRentValue(e.target.value.replace(/[^0-9.\-]/g, '')))} />
            {sample != null && <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>A {money(1000)} rent becomes {money(sample)}.</span>}
          </label>
        )}

        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', lineHeight: 1.55, marginBottom: 12 }}>
          Each household's current lease keeps running, at today's rent, until the day before {startDate ? longDate(startDate) : 'the start date'}, then ends on its own —
          a signed lease that ends sooner carries on until then too, so nobody is ever without a lease.
          From that day they are billed the new rent whether or not they have signed; the new lease stays open for their signature.
          You sign each one now, one after another — nothing reaches a household until you have signed theirs.
        </div>

        {made && (
          <div style={{ border: '1px solid var(--amber)', background: 'rgba(245,166,35,.06)', borderRadius: 10, padding: 12, marginBottom: 12, fontSize: '.8rem', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>
              {made.created.length} new lease{made.created.length === 1 ? '' : 's'} drafted · {made.skipped.length} left out
            </div>
            {made.skipped.map(k => (
              <div key={k.leaseId} style={{ color: 'var(--text-2)' }}>{k.unitNumber} — {k.reason}</div>
            ))}
            <div style={{ color: 'var(--text-3)', marginTop: 6 }}>
              The ones left out are untouched. Send any of them later from its own row (Change → New lease from a date…).
            </div>
          </div>
        )}

        {rows && !made && (
          <div style={{ border: '1px solid var(--border-0)', borderRadius: 10, maxHeight: 320, overflowY: 'auto', marginBottom: 12 }}>
            {rows.length === 0 && <div style={{ padding: 14, fontSize: '.8rem', color: 'var(--text-3)' }}>No leases in force at this property.</div>}
            {rows.map(r => (
              <label key={r.leaseId} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', borderBottom: '1px solid var(--border-0)', opacity: r.ok ? 1 : 0.6, cursor: r.ok ? 'pointer' : 'default' }}>
                <input type="checkbox" disabled={!r.ok} checked={r.ok && kept.has(r.leaseId)} style={{ marginTop: 3 }}
                  onChange={e => setKept(prev => { const n = new Set(prev); e.target.checked ? n.add(r.leaseId) : n.delete(r.leaseId); return n })} />
                <div style={{ flex: 1, fontSize: '.8rem' }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{r.unitNumber} · {r.tenantNames}</div>
                  {r.ok
                    ? <div style={{ color: 'var(--text-2)' }}>{money(r.currentRent)} → <strong>{money(r.newRent)}</strong> a month · {r.templateName}
                        {r.note && <div style={{ color: 'var(--text-3)', fontSize: '.74rem' }}>{r.note}</div>}</div>
                    : <div style={{ color: 'var(--amber)' }}>Not included: {r.reason}</div>}
                </div>
              </label>
            ))}
          </div>
        )}

        {error && (
          <div style={{ color: 'var(--red)', fontSize: '.78rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>{error}</div>
        )}

        <div className="modal-footer">
          {made ? (
            <>
              <button className="btn btn-ghost" onClick={onClose}>Close — sign them later</button>
              <button className="btn btn-primary" onClick={() => goSign(made.created)}>
                Sign the {made.created.length} drafted
              </button>
            </>
          ) : (<>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {!rows ? (
            <button className="btn btn-primary" disabled={!ready || previewMut.isLoading} onClick={() => { setError(null); previewMut.mutate({}) }}>
              {previewMut.isLoading ? 'Checking…' : 'Show who gets one'}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={keptCount === 0 || createMut.isLoading} onClick={() => { setError(null); createMut.mutate() }}>
              {createMut.isLoading ? 'Creating…' : `Create ${keptCount} new lease${keptCount === 1 ? '' : 's'} and sign them`}
            </button>
          )}
          </>)}
        </div>
      </div>
    </div>
  )
}
