import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { RefreshCw, CalendarX2, FileSignature, Send } from 'lucide-react'
import { appConfirm } from '../components/dialogs'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const fmtDate = (d: any) => d ? new Date(d).toLocaleDateString() : '—'
const lbl = { fontSize:'.75rem', color:'var(--text-3)', marginBottom:4 } as const

// W-7 (S531), reworked S534 (Nic): the one-minute renewal.
// Renew → drafts a new lease from the SAME template the current lease
// was executed on (preselected; changeable), auto-sends it, and drops
// the landlord straight into the signing view where they type the new
// rent/dates into the document (lease-is-law: the terms live in the
// lease). If a renewal draft is already open, this modal OPENS it —
// no more duplicate-draft dead end. Don't renew → arms the natural
// lease-end path (expire + vacate at end date) and notifies tenants.
export function RenewalDecisionModal({ leaseId, onClose }: { leaseId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: lease } = useQuery<any>(['lease', leaseId], () => apiGet(`/leases/${leaseId}`))
  // S535: templates are per unit TYPE and may be PROPERTY-locked — only
  // offer ones compatible with this unit (type + property, plus
  // unlocked/universal templates).
  const { data: templates = [] } = useQuery<any[]>(
    ['esign-templates', lease?.unitType ?? 'all', lease?.propertyId ?? 'all'],
    () => apiGet(`/esign/templates?${[
      lease?.unitType ? `unitType=${lease.unitType}` : '',
      lease?.propertyId ? `propertyId=${lease.propertyId}` : '',
    ].filter(Boolean).join('&')}`),
    { enabled: !!lease })
  const { data: ctx } = useQuery<any>(['renewal-context', leaseId],
    () => apiGet(`/esign/documents/renewal-context/${leaseId}`))

  const [decision, setDecision] = useState<'offer'|'renew'|'non_renew'|null>(null)
  const [templateId, setTemplateId] = useState('')
  const [error, setError] = useState<string|null>(null)
  const [working, setWorking] = useState(false)

  // S535 auto-pull: the unit's TYPE selects the template. Priority —
  // the template the current lease was executed from (if still
  // compatible) → the newest template written for this exact unit type
  // → a lone universal template. Changeable in the picker either way.
  useEffect(() => {
    if (templateId || !lease) return
    const list = templates as any[]
    if (ctx?.priorTemplateId && list.some((t:any) => t.id === ctx.priorTemplateId)) {
      setTemplateId(ctx.priorTemplateId)
      return
    }
    // Most specific wins: locked to THIS property + exact type → exact
    // type → lone remaining option.
    const propertyExact = list.filter((t:any) => t.propertyId === lease.propertyId && t.unitType === lease.unitType)
    if (propertyExact.length > 0) { setTemplateId(propertyExact[0].id); return }
    const exact = list.filter((t:any) => t.unitType && t.unitType === lease.unitType)
    if (exact.length > 0) { setTemplateId(exact[0].id); return }
    if (list.length === 1) setTemplateId(list[0].id)
  }, [ctx, templates, lease])

  // GAM standard: THE LEASE IS THE DOCUMENT — this form collects no terms.
  // Draft → auto-send (landlord signs first per S28) → open the signing
  // view. The landlord enters the new rent/dates there and signs; the
  // tenant is emailed automatically after.
  const draftAndOpen = async () => {
    setWorking(true)
    setError(null)
    try {
      const drafted: any = await apiPost('/esign/documents/renewal', { leaseId, templateId })
      const docId = drafted?.data?.id ?? drafted?.id
      if (!docId) throw new Error('Draft did not return a document id')
      await apiPost(`/esign/documents/${docId}/send`, {})
      qc.invalidateQueries('landlord-todos')
      qc.invalidateQueries('esign-docs')
      onClose()
      navigate(`/sign/${docId}`)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not draft the renewal')
      setWorking(false)
    }
  }

  const openDraft = ctx?.openDraft
  const openExistingDraft = async () => {
    // A draft that was never sent has no live signing session — send it
    // on the way in (idempotent for already-sent docs is not needed;
    // only 'draft' status docs take this branch).
    setWorking(true)
    setError(null)
    try {
      if (openDraft.status === 'draft') {
        await apiPost(`/esign/documents/${openDraft.id}/send`, {})
      }
      onClose()
      navigate(`/sign/${openDraft.id}`)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not open the renewal draft')
      setWorking(false)
    }
  }
  const voidMut = useMutation(
    () => apiPost(`/esign/documents/${openDraft.id}/void`, {}),
    {
      onSuccess: () => { qc.invalidateQueries(['renewal-context', leaseId]); qc.invalidateQueries('esign-docs'); setError(null) },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not void the draft'),
    }
  )

  const nonRenewMut = useMutation(
    () => apiPost(`/leases/${leaseId}/non-renewal`, {}),
    {
      onSuccess: () => { qc.invalidateQueries('landlord-todos'); qc.invalidateQueries('leases'); onClose() },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not record the non-renewal'),
    }
  )
  // S562: landlord-first — offer renewal releases the "do you want to renew?"
  // survey to the tenant. You draft the lease only after they say yes.
  const offerMut = useMutation(
    () => apiPost(`/leases/${leaseId}/offer-renewal`, {}),
    {
      onSuccess: () => { qc.invalidateQueries('landlord-todos'); qc.invalidateQueries(['lease', leaseId]); onClose() },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not offer renewal'),
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
              <div className="data-row"><span className="data-key">Tenant{(lease.tenants||[]).length > 1 ? 's' : ''}</span><span className="data-val">{(lease.tenants||[]).map((t:any)=>[t.firstName, t.lastName].filter(Boolean).join(' ')).join(', ') || '—'}</span></div>
              <div className="data-row"><span className="data-key">Current rent</span><span className="data-val mono">{fmt(currentRent)}/mo</span></div>
              <div className="data-row"><span className="data-key">Lease ends</span><span className="data-val">{fmtDate(lease.endDate)}</span></div>
            </div>

            {openDraft ? (
              // S534: a renewal is already in flight — surface it HERE
              // instead of a duplicate-draft error with no way to find it.
              <>
                <div style={{ border:'1px solid var(--gold)', background:'rgba(201,162,39,.07)', borderRadius:10, padding:14, marginBottom:14 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:700, fontSize:'.88rem', marginBottom:6 }}>
                    <FileSignature size={15} style={{ color:'var(--gold)' }}/> Renewal already in progress
                  </div>
                  <div style={{ fontSize:'.78rem', color:'var(--text-2)', lineHeight:1.5 }}>
                    {openDraft.landlordSignerStatus === 'signed'
                      ? 'You\'ve signed — the renewal lease is with the tenant now. You can still void it if plans changed.'
                      : 'The renewal lease is drafted and waiting on you. Open it, type in the new rent and dates, and sign — the tenant gets it automatically.'}
                  </div>
                </div>
                {error && <div style={{ color:'var(--red)', fontSize:'.78rem', background:'rgba(255,71,87,.08)', border:'1px solid rgba(255,71,87,.2)', borderRadius:8, padding:'8px 12px', marginBottom:12 }}>{error}</div>}
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={onClose}>Close</button>
                  <button className="btn btn-ghost" disabled={voidMut.isLoading || working}
                    onClick={()=>{ appConfirm('Void this renewal draft? Any values already entered are discarded.', { danger: true, confirmLabel: 'Void draft' }).then(ok => { if (ok) voidMut.mutate() }) }}>
                    {voidMut.isLoading ? 'Voiding…' : 'Void draft'}
                  </button>
                  {openDraft.landlordSignerStatus !== 'signed' && (
                    <button className="btn btn-primary" disabled={working} onClick={openExistingDraft}>
                      {working ? 'Opening…' : 'Open & Sign the Lease'}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* Decision cards */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
                  {[
                    { key:'offer', icon:Send, label:'Offer Renewal', desc:'Ask the tenant first — releases a "do you want to renew?" survey to them', color:'var(--gold)' },
                    { key:'renew', icon:RefreshCw, label:'Renew Now', desc:'Skip the survey — draft the renewal lease now and sign it', color:'var(--gold)' },
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
                      {templates.map((t:any)=><option key={t.id} value={t.id}>{t.name}{t.id === ctx?.priorTemplateId ? ' (current lease)' : ''}</option>)}
                    </select>
                    {templates.length === 0 && <div style={{ fontSize:'.72rem', color:'var(--amber)', marginTop:4 }}>No lease templates yet — create one on the E-Sign page first.</div>}
                    <div style={{ fontSize:'.72rem', color:'var(--text-3)', lineHeight:1.5, marginTop:10 }}>
                      The lease is the document: the drafted lease opens for signing <strong>right now</strong> — type the new rent and dates into it, sign, and it goes to the tenant{(lease.tenants||[]).length > 1 ? 's' : ''} automatically. Tenant details, recurring fees, and the held deposit carry over — the deposit is never re-billed.
                    </div>
                  </div>
                )}

                {decision === 'offer' && (
                  <div style={{ background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.2)', borderRadius:10, padding:14, marginBottom:14, fontSize:'.78rem', lineHeight:1.5 }}>
                    The tenant{(lease.tenants||[]).length > 1 ? 's are' : ' is'} asked whether they want to renew. You draft the new lease only after they say yes — so you never prepare a renewal they don't want. If they decline (or the lease reaches its end with no response), it ends on its end date.
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
                  {decision === 'offer' && (
                    <button className="btn btn-primary" disabled={offerMut.isLoading} onClick={()=>offerMut.mutate()}>
                      {offerMut.isLoading ? 'Offering…' : 'Offer Renewal to Tenant'}
                    </button>
                  )}
                  {decision === 'renew' && (
                    <button className="btn btn-primary" disabled={!canSubmitRenew || working} onClick={draftAndOpen}>
                      {working ? 'Drafting…' : 'Draft & Open for Signing'}
                    </button>
                  )}
                  {decision === 'non_renew' && (
                    <button className="btn btn-primary" disabled={nonRenewMut.isLoading} onClick={()=>{ appConfirm('Record the non-renewal and notify the tenants now?', { confirmLabel: 'Record non-renewal' }).then(ok => { if (ok) nonRenewMut.mutate() }) }}>
                      {nonRenewMut.isLoading ? 'Recording…' : 'Confirm Non-Renewal'}
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
