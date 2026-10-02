import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { RefreshCw, CalendarX2, FileSignature, Send } from 'lucide-react'
import { appConfirm } from '../components/dialogs'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
// The calendar day as written ('YYYY-MM-DD…'), never shifted by the browser's
// clock — a bare date read as UTC midnight showed the day before in Phoenix.
const fmtDate = (d: any) => d
  ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC' })
  : '—'
/** 'YYYY-MM-DD' as "January 1, 2027", read as that calendar day. */
const longDate = (iso: string | null | undefined) => iso
  ? new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : '—'
const lbl = { fontSize:'.75rem', color:'var(--text-3)', marginBottom:4 } as const
/** The calendar day after 'YYYY-MM-DD…'. */
const dayAfter = (iso: string | null | undefined) => {
  if (!iso) return null
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// W-7 (S531), reworked S534 (Nic): the one-minute renewal.
// Renew → drafts a new lease from the SAME template the current lease
// was executed on (preselected; changeable), auto-sends it, and drops
// the landlord straight into the signing view where they type the new
// rent/dates into the document (lease-is-law: the terms live in the
// lease). If a renewal draft is already open, this modal OPENS it —
// no more duplicate-draft dead end. Don't renew → arms the natural
// lease-end path (expire + vacate at end date) and notifies tenants.
//
// S655 (Nic, 10/2): "New lease from a date…" for EVERY lease in force,
// month-to-month included. A month-to-month has nothing to "not renew" and no
// end date to show, so its window is only the new lease. Whatever the lease,
// the rule is the same and is said plainly: the current lease runs until the
// day before the new one starts; from that day the household is billed the new
// rent whether or not they have signed; the new lease stays open for their
// signature, and the landlord hears 14 days before and on the day if not.
export function RenewalDecisionModal({ leaseId, onClose }: { leaseId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: lease } = useQuery<any>(['lease', leaseId], () => apiGet(`/leases/${leaseId}`))
  // S535: templates are per unit TYPE and may be PROPERTY-locked — only
  // offer ones compatible with this unit (type + property, plus
  // unlocked/universal templates). S655: lease forms only.
  const { data: templates = [] } = useQuery<any[]>(
    ['esign-templates', lease?.unitType ?? 'all', lease?.propertyId ?? 'all', 'lease'],
    () => apiGet(`/esign/templates?${[
      lease?.unitType ? `unitType=${lease.unitType}` : '',
      lease?.propertyId ? `propertyId=${lease.propertyId}` : '',
      'purpose=lease',
    ].filter(Boolean).join('&')}`),
    { enabled: !!lease })
  // Fresh at the moment of action — never a stale "nothing in progress".
  const { data: ctx } = useQuery<any>(['renewal-context', leaseId],
    () => apiGet(`/esign/documents/renewal-context/${leaseId}`),
    { staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: true })

  const monthToMonth = !!lease && !lease.endDate
  // A signed term already HOLDING OVER (decisions 10/2 #7): its end date was
  // carried past the end the household signed, which the server keeps. A
  // held-over day is never called the end of the signed lease.
  const signedEnd: string | null = (!monthToMonth && lease?.holdoverSignedEndDate) || null
  const heldOver = !!signedEnd
  const [decision, setDecision] = useState<'offer'|'renew'|'non_renew'|null>(null)
  const [templateId, setTemplateId] = useState('')
  const [error, setError] = useState<string|null>(null)
  const [working, setWorking] = useState(false)
  // A month-to-month has one path: the new lease.
  useEffect(() => { if (monthToMonth && decision === null) setDecision('renew') }, [monthToMonth, decision])

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

  const refreshAll = () => {
    qc.invalidateQueries(['renewal-context', leaseId])
    qc.invalidateQueries('landlord-todos')
    qc.invalidateQueries('esign-docs')
    qc.invalidateQueries('leases')
    qc.invalidateQueries('landlord-pending')
  }

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
      if (!docId) throw new Error('The new lease did not save. Press the button again.')
      await apiPost(`/esign/documents/${docId}/send`, {})
      refreshAll()
      onClose()
      navigate(`/sign/${docId}`)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not start the new lease. Press the button again.')
      // Whatever happened, show what is true now (a draft may exist after all).
      qc.invalidateQueries(['renewal-context', leaseId])
      setWorking(false)
    }
  }

  const openDraft = ctx?.openDraft
  const signedNext = ctx?.signedNext
  const landlordSigned = openDraft?.landlordSignerStatus === 'signed'
  // Once its start date has come it is the household's lease (by the property's
  // calendar — the server says so, never the browser clock).
  const draftStarted = !!openDraft?.started
  // Whether "Cancel" is offered is the SERVER's answer — the very test its cancel
  // route runs (started, the lease before it already over, anyone in the
  // household signed) — so the window never shows a button that would be
  // refused. When it can't be canceled the window shows the server's reason,
  // which always ends with the next step.
  const canCancel = !!openDraft?.canCancel
  const cancelRefusal: string | null = openDraft && !openDraft.canCancel ? (openDraft.cancelRefusal ?? null) : null
  // What canceling does to the lease in force, said in the confirm: a
  // month-to-month just carries on; a lease with an end date ends on it unless
  // another new lease is sent before then.
  const cancelConfirmText = !landlordSigned
    ? 'Throw away this draft? Anything typed into it is discarded. The current lease carries on as it is.'
    : lease?.endDate
      ? `Cancel the new lease? The current lease carries on as it is through ${longDate(lease.endDate)} and ends then — ` +
        'unless you send them another new lease before that day, it is treated as a move-out. Any deposit change on the new one is taken back.'
      : 'Cancel the new lease? The current lease carries on exactly as it is, and any deposit change on the new one is taken back.'
  const openExistingDraft = async () => {
    // A draft that was never sent has no live signing session — send it
    // on the way in (only 'pending' / 'draft' status docs take this branch).
    setWorking(true)
    setError(null)
    try {
      if (openDraft.status === 'draft' || openDraft.status === 'pending') {
        await apiPost(`/esign/documents/${openDraft.id}/send`, {})
      }
      onClose()
      navigate(`/sign/${openDraft.id}`)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not open the new lease. Press the button again.')
      qc.invalidateQueries(['renewal-context', leaseId])
      setWorking(false)
    }
  }
  const voidMut = useMutation(
    () => apiPost(`/esign/documents/${openDraft.id}/void`, { reason: 'canceled by the landlord' }),
    {
      onSuccess: () => { refreshAll(); setError(null) },
      onError: (e: any) => { setError(e?.response?.data?.error || 'Could not cancel the new lease. Press the button again.'); qc.invalidateQueries(['renewal-context', leaseId]) },
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
  const plural = (lease?.tenants || []).length > 1

  const errorBox = error && (
    <div style={{ color:'var(--red)', fontSize:'.78rem', background:'rgba(255,71,87,.08)', border:'1px solid rgba(255,71,87,.2)', borderRadius:8, padding:'8px 12px', marginBottom:12 }}>{error}</div>
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{monthToMonth ? 'New lease from a date' : 'Renewal Decision'}</div>
        {!lease ? <div style={{ color:'var(--text-3)', padding:16 }}>Loading…</div> : (
          <>
            <div style={{ background:'var(--bg-3)', borderRadius:10, padding:14, marginBottom:14, fontSize:'.82rem' }}>
              <div className="data-row"><span className="data-key">Unit</span><span className="data-val">{lease.unitNumber} — {lease.propertyName}</span></div>
              <div className="data-row"><span className="data-key">Tenant{plural ? 's' : ''}</span><span className="data-val">{(lease.tenants||[]).map((t:any)=>[t.firstName, t.lastName].filter(Boolean).join(' ')).join(', ') || '—'}</span></div>
              <div className="data-row"><span className="data-key">Current rent</span><span className="data-val mono">{fmt(currentRent)}/mo</span></div>
              <div className="data-row"><span className="data-key">Current lease</span><span className="data-val">{monthToMonth ? 'Month to month'
                : heldOver ? `Signed through ${fmtDate(signedEnd)} · staying on at today's rent through ${fmtDate(lease.endDate)}`
                : `Ends ${fmtDate(lease.endDate)}`}</span></div>
            </div>

            {signedNext ? (
              <>
                <div style={{ border:'1px solid var(--gold)', background:'rgba(201,162,39,.07)', borderRadius:10, padding:14, marginBottom:14 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:700, fontSize:'.88rem', marginBottom:6 }}>
                    <FileSignature size={15} style={{ color:'var(--gold)' }}/> New lease signed by everyone
                  </div>
                  <div style={{ fontSize:'.78rem', color:'var(--text-2)', lineHeight:1.5 }}>
                    It starts {longDate(signedNext.startDate)} at {fmt(signedNext.rentAmount)} a month. The current lease ends the day before, on its own. Nothing else to do.
                  </div>
                </div>
                {errorBox}
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={onClose}>Close</button>
                </div>
              </>
            ) : openDraft ? (
              // S534: a new lease is already in flight — surface it HERE
              // instead of a duplicate-draft error with no way to find it.
              <>
                <div style={{ border:'1px solid var(--gold)', background:'rgba(201,162,39,.07)', borderRadius:10, padding:14, marginBottom:14 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:700, fontSize:'.88rem', marginBottom:6 }}>
                    <FileSignature size={15} style={{ color:'var(--gold)' }}/> New lease in progress
                  </div>
                  <div style={{ fontSize:'.78rem', color:'var(--text-2)', lineHeight:1.5 }}>
                    {draftStarted
                      ? <>It started <strong>{longDate(openDraft.startDate)}</strong> at {fmt(openDraft.rentAmount)} a month and is the household's lease now.
                         {' '}{openDraft.tenantSigned ? 'Some of the household has signed; it stays open for the rest.' : 'They have not signed it yet; it stays open for them.'}</>
                      : landlordSigned
                      ? <>You've signed it. It starts <strong>{longDate(openDraft.startDate)}</strong> at {fmt(openDraft.rentAmount)} a month,
                         whether or not the household signs — the current lease carries on at today's rent until the day before.{' '}
                         {openDraft.tenantSigned ? 'Some of the household has signed it; it stays open for the rest.' : 'The household has not signed yet; it stays open for them.'}</>
                      : 'The new lease is drafted and waiting on you. Open it, type the new rent and start date, and sign — the household gets it automatically.'}
                  </div>
                  {/* The server's own reason it can't be canceled, with the next step. */}
                  {cancelRefusal && (
                    <div style={{ fontSize:'.76rem', color:'var(--text-2)', lineHeight:1.5, marginTop:8, paddingTop:8, borderTop:'1px solid rgba(201,162,39,.2)' }}>
                      {cancelRefusal}
                    </div>
                  )}
                </div>
                {errorBox}
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={onClose}>Close</button>
                  {canCancel && (
                    <button className="btn btn-primary" disabled={voidMut.isLoading || working}
                      onClick={()=>{ appConfirm(cancelConfirmText,
                        { danger: true, confirmLabel: landlordSigned ? 'Cancel the new lease' : 'Throw away draft' }).then(ok => { if (ok) voidMut.mutate() }) }}>
                      {voidMut.isLoading ? 'Canceling…' : landlordSigned ? 'Cancel the new lease' : 'Throw away draft'}
                    </button>
                  )}
                  {!landlordSigned && (
                    <button className="btn btn-primary" disabled={working} onClick={openExistingDraft}>
                      {working ? 'Opening…' : 'Open & Sign the Lease'}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* Decision cards — a fixed term only. A month-to-month has one path. */}
                {!monthToMonth && (
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
                    {[
                      { key:'offer', icon:Send, label:'Offer Renewal', desc:'Ask the tenant first — releases a "do you want to renew?" survey to them', color:'var(--gold)' },
                      { key:'renew', icon:RefreshCw, label:'New Lease Now', desc:'Skip the survey — draft the new lease now and sign it', color:'var(--gold)' },
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
                )}

                {decision === 'renew' && (
                  <div style={{ marginBottom:14 }}>
                    <div style={lbl}>Lease form *</div>
                    <select className="form-select" value={templateId} onChange={e=>setTemplateId(e.target.value)} style={{ width:'100%' }}>
                      <option value="" disabled>Pick the lease form…</option>
                      {templates.map((t:any)=><option key={t.id} value={t.id}>{t.name}{t.id === ctx?.priorTemplateId ? ' (current lease)' : ''}</option>)}
                    </select>
                    {templates.length === 0 && <div style={{ fontSize:'.72rem', color:'var(--amber)', marginTop:4 }}>No lease forms yet — add one on the GoldSign page first.</div>}
                    <div style={{ fontSize:'.72rem', color:'var(--text-3)', lineHeight:1.55, marginTop:10 }}>
                      The new lease opens for signing <strong>right now</strong>. Type the new rent and the start date into it
                      {monthToMonth
                        ? ' (it starts on the 1st of the month after next unless you change it)'
                        : heldOver
                          ? ` (it starts ${longDate(dayAfter(lease.endDate))}, the day after the current lease ends, unless you change it)`
                          : ` (it starts ${longDate(dayAfter(lease.endDate))}, the day after the current lease ends, unless you change it to a later date)`}, sign, and it goes to the tenant{plural ? 's' : ''} automatically.
                      {monthToMonth
                        ? ' The current lease keeps running until the day before the new one starts, then ends on its own.'
                        : heldOver
                          ? ` Their signed term ended ${longDate(signedEnd)}; they are staying on at today's rent through ${longDate(lease.endDate)}. The new lease can start any day after ${longDate(signedEnd)} — the current lease runs until the day before it, so there is never a stretch with no lease.`
                          : ' The current lease is signed through its end date, so the new one cannot start before the day after. If you pick a later start, the household stays on the current lease at today\'s rent until the day before — there is never a stretch with no lease.'}
                      From the start date the household is billed the new rent <strong>whether or not they have signed</strong>; the new lease stays open for their signature,
                      and you'll be told 14 days before it starts and on the day if they haven't signed.
                      Tenant details, recurring fees and the held deposit carry over — the deposit is never billed again.
                    </div>
                  </div>
                )}

                {decision === 'offer' && (
                  <div style={{ background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.2)', borderRadius:10, padding:14, marginBottom:14, fontSize:'.78rem', lineHeight:1.5 }}>
                    The tenant{plural ? 's are' : ' is'} asked whether they want to renew. You draft the new lease only after they say yes — so you never prepare a renewal they don't want. If they decline (or the lease reaches its end with no response), it ends on its end date.
                  </div>
                )}

                {decision === 'non_renew' && (
                  <div style={{ background:'rgba(255,71,87,.06)', border:'1px solid rgba(255,71,87,.2)', borderRadius:10, padding:14, marginBottom:14, fontSize:'.78rem', lineHeight:1.5 }}>
                    The lease ends <strong>{fmtDate(lease.endDate)}</strong> and will not auto-renew. All tenants on the lease are notified immediately. On the end date the unit is vacated and the deposit-return process starts automatically. Check your local notice-period requirements — some jurisdictions require advance written notice.
                  </div>
                )}

                {errorBox}

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
