import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { RefreshCw, CalendarX2 } from 'lucide-react'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const fmtDate = (d: any) => d ? new Date(d).toLocaleDateString() : '—'
const lbl = { fontSize:'.75rem', color:'var(--text-3)', marginBottom:4 } as const

// W-7 (S531): the renewal decision form the expiring-lease to-do opens.
// Renew → drafts a NEW lease into e-sign with these terms carried in
// (lease-is-law: the terms live in the drafted lease); the landlord
// reviews + sends from the E-Sign page. Don't renew → arms the natural
// lease-end path (expire + vacate at end date) and notifies the tenants.
export function RenewalDecisionModal({ leaseId, onClose }: { leaseId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: lease } = useQuery<any>(['lease', leaseId], () => apiGet(`/leases/${leaseId}`))
  const { data: templates = [] } = useQuery<any[]>('esign-templates', () => apiGet('/esign/templates'))

  const [decision, setDecision] = useState<'renew'|'non_renew'|null>(null)
  const [templateId, setTemplateId] = useState('')
  const [error, setError] = useState<string|null>(null)

  // GAM standard: THE LEASE IS THE DOCUMENT — this form collects no terms.
  // The landlord sets the new rent/dates inside the drafted lease during
  // their signing pass; this modal only records the decision and picks
  // which template to draft from.
  const renewMut = useMutation(
    () => apiPost('/esign/documents/renewal', { leaseId, templateId }),
    {
      onSuccess: () => { qc.invalidateQueries('landlord-todos'); onClose(); navigate('/esign') },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not draft the renewal'),
    }
  )
  const nonRenewMut = useMutation(
    () => apiPost(`/leases/${leaseId}/non-renewal`, {}),
    {
      onSuccess: () => { qc.invalidateQueries('landlord-todos'); qc.invalidateQueries('leases'); onClose() },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not record the non-renewal'),
    }
  )

  const currentRent = lease?.rentAmount != null ? Number(lease.rentAmount) : null
  const canSubmitRenew = !!templateId

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Renewal Decision</div>
        {!lease ? <div style={{ color:'var(--text-3)', padding:16 }}>Loading…</div> : (
          <>
            <div style={{ background:'var(--bg-3)', borderRadius:10, padding:14, marginBottom:14, fontSize:'.82rem' }}>
              <div className="data-row"><span className="data-key">Unit</span><span className="data-val">{lease.unitNumber} — {lease.propertyName}</span></div>
              <div className="data-row"><span className="data-key">Tenant{(lease.tenants||[]).length > 1 ? 's' : ''}</span><span className="data-val">{(lease.tenants||[]).map((t:any)=>[t.firstName ?? t.first_name, t.lastName ?? t.last_name].filter(Boolean).join(' ')).join(', ') || '—'}</span></div>
              <div className="data-row"><span className="data-key">Current rent</span><span className="data-val mono">{fmt(currentRent)}/mo</span></div>
              <div className="data-row"><span className="data-key">Lease ends</span><span className="data-val">{fmtDate(lease.endDate)}</span></div>
            </div>

            {/* Decision cards */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
              {[
                { key:'renew', icon:RefreshCw, label:'Renew', desc:'Draft a new lease for signature with updated terms', color:'var(--gold)' },
                { key:'non_renew', icon:CalendarX2, label:"Don't Renew", desc:'Lease ends on its end date; tenants are notified now', color:'var(--red)' },
              ].map((c:any) => (
                <div key={c.key} onClick={()=>{ setDecision(c.key); setError(null) }}
                  style={{ padding:'12px 14px', borderRadius:10, cursor:'pointer', transition:'all .12s',
                    border:`1px solid ${decision===c.key ? c.color : 'var(--border-0)'}`,
                    background: decision===c.key ? `${c.color}12` : 'var(--bg-2)' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:700, fontSize:'.88rem', marginBottom:4 }}>
                    <c.icon size={14} style={{ color:c.color }}/> {c.label}
                  </div>
                  <div style={{ fontSize:'.72rem', color:'var(--text-3)', lineHeight:1.4 }}>{c.desc}</div>
                </div>
              ))}
            </div>

            {decision === 'renew' && (
              <div style={{ marginBottom:14 }}>
                <div style={lbl}>Lease template *</div>
                <select className="form-select" value={templateId} onChange={e=>setTemplateId(e.target.value)} style={{ width:'100%' }}>
                  <option value="" disabled>Select a template…</option>
                  {templates.map((t:any)=><option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                {templates.length === 0 && <div style={{ fontSize:'.72rem', color:'var(--amber)', marginTop:4 }}>No lease templates yet — create one on the E-Sign page first.</div>}
                <div style={{ fontSize:'.72rem', color:'var(--text-3)', lineHeight:1.5, marginTop:10 }}>
                  The lease is the document: you'll set the new rent, dates, and any changed terms <strong>directly in the drafted lease</strong> when you sign it on the E-Sign page, then it goes to the tenant{(lease.tenants||[]).length > 1 ? 's' : ''}. Tenant details, recurring fees, and the held deposit carry over automatically — the deposit is never re-billed.
                </div>
              </div>
            )}

            {decision === 'non_renew' && (
              <div style={{ background:'rgba(255,71,87,.06)', border:'1px solid rgba(255,71,87,.2)', borderRadius:10, padding:14, marginBottom:14, fontSize:'.78rem', lineHeight:1.5 }}>
                The lease ends <strong>{fmtDate(lease.endDate)}</strong> and will not auto-renew. All tenants on the lease are notified immediately. On the end date the unit is vacated and the deposit-return process starts automatically. Check your local notice-period requirements — some jurisdictions require advance written notice.
              </div>
            )}

            {error && <div style={{ color:'var(--red)', fontSize:'.78rem', background:'rgba(255,71,87,.08)', border:'1px solid rgba(255,71,87,.2)', borderRadius:8, padding:'8px 12px', marginBottom:12 }}>{error}</div>}

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              {decision === 'renew' && (
                <button className="btn btn-primary" disabled={!canSubmitRenew || renewMut.isLoading} onClick={()=>renewMut.mutate()}>
                  {renewMut.isLoading ? 'Drafting…' : 'Draft Renewal Lease'}
                </button>
              )}
              {decision === 'non_renew' && (
                <button className="btn btn-primary" disabled={nonRenewMut.isLoading} onClick={()=>{ if (window.confirm('Record the non-renewal and notify the tenants now?')) nonRenewMut.mutate() }}>
                  {nonRenewMut.isLoading ? 'Recording…' : 'Confirm Non-Renewal'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
