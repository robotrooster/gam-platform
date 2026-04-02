import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { X, Mail, User, DoorOpen, Copy, Check, ChevronRight, ChevronLeft } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

interface Props { onClose: () => void }

const STEPS = ['Tenant Info', 'Unit Assignment', 'Confirm']

export function InviteTenantModal({ onClose }: Props) {
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', phone: '', unitId: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [inviteResult, setInviteResult] = useState<{ acceptUrl: string; email: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const { data: units = [] } = useQuery<any[]>('vacant-units', () =>
    apiGet('/units').then((all: any[]) => all.filter(u => !u.tenant_id))
  )

  const inviteMut = useMutation(
    (data: any) => apiPost('/tenants/invite', data),
    {
      onSuccess: (res: any) => {
        qc.invalidateQueries('tenants')
        qc.invalidateQueries('units')
        setInviteResult({ acceptUrl: res.data.acceptUrl, email: res.data.email })
      }
    }
  )

  const set = (key: string, val: string) => {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => ({ ...e, [key]: '' }))
  }

  const selectedUnit = (units as any[]).find(u => u.id === form.unitId)

  const validateStep = () => {
    const errs: Record<string, string> = {}
    if (step === 0) {
      if (!form.email.trim()) errs.email = 'Email required'
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Invalid email'
      if (!form.firstName.trim()) errs.firstName = 'First name required'
    }
    if (step === 1 && !form.unitId) errs.unitId = 'Select a unit'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const next = () => { if (validateStep()) setStep(s => s + 1) }
  const back = () => setStep(s => s - 1)

  const submit = () => {
    inviteMut.mutate({
      email: form.email.trim(),
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      phone: form.phone.trim() || undefined,
      unitId: form.unitId,
    })
  }

  const copyLink = () => {
    if (!inviteResult) return
    navigator.clipboard.writeText(inviteResult.acceptUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Success screen
  if (inviteResult) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
          <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(30,219,122,.12)', border: '2px solid var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <Check size={24} style={{ color: 'var(--green)' }} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 6 }}>Invite Sent</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>
              {inviteResult.email} will receive an email to set up their account.
            </div>
          </div>

          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>
              Invite Link — share directly if needed
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '.68rem', color: 'var(--text-2)', background: 'var(--bg-3)', border: '1px solid var(--border-0)', borderRadius: 6, padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {inviteResult.acceptUrl}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={copyLink} style={{ flexShrink: 0, gap: 5 }}>
                {copied ? <><Check size={13} style={{ color: 'var(--green)' }} /> Copied</> : <><Copy size={13} /> Copy</>}
              </button>
            </div>
          </div>

          <div style={{ fontSize: '.75rem', color: 'var(--text-3)', background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.15)', borderRadius: 8, padding: '10px 12px', marginBottom: 20, lineHeight: 1.6 }}>
            ⚡ Unit has been assigned. The tenant will appear as <strong style={{ color: 'var(--amber)' }}>Pending</strong> until they complete their account setup and verify their bank account.
          </div>

          <button className="btn btn-primary" style={{ width: '100%' }} onClick={onClose}>Done</button>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 500 }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div className="modal-title" style={{ marginBottom: 6 }}>Invite Tenant</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {STEPS.map((s, i) => (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '.65rem', fontWeight: 700,
                    background: i < step ? 'var(--green)' : i === step ? 'var(--gold)' : 'var(--bg-3)',
                    color: i <= step ? 'var(--bg-0)' : 'var(--text-3)',
                    border: `1px solid ${i < step ? 'var(--green)' : i === step ? 'var(--gold)' : 'var(--border-0)'}`,
                    transition: 'all .2s'
                  }}>
                    {i < step ? <Check size={11} /> : i + 1}
                  </div>
                  <span style={{ fontSize: '.65rem', color: i === step ? 'var(--text-1)' : 'var(--text-3)', fontWeight: i === step ? 600 : 400 }}>{s}</span>
                  {i < STEPS.length - 1 && <div style={{ width: 16, height: 1, background: 'var(--border-0)', margin: '0 2px' }} />}
                </div>
              ))}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {/* Step 0: Tenant Info */}
        {step === 0 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Enter the tenant's contact information. They'll receive an invite to set up their account.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>First Name *</label>
                <input className="input" placeholder="Jane" value={form.firstName} onChange={e => set('firstName', e.target.value)} autoFocus style={{ width: '100%' }} />
                {errors.firstName && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.firstName}</div>}
              </div>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Last Name</label>
                <input className="input" placeholder="Smith" value={form.lastName} onChange={e => set('lastName', e.target.value)} style={{ width: '100%' }} />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Email Address *</label>
              <div style={{ position: 'relative' }}>
                <Mail size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input className="input" type="email" placeholder="jane@example.com" value={form.email} onChange={e => set('email', e.target.value)} style={{ width: '100%', paddingLeft: 32 }} />
              </div>
              {errors.email && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.email}</div>}
            </div>

            <div style={{ marginBottom: 4 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Phone <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
              <input className="input" type="tel" placeholder="(555) 000-0000" value={form.phone} onChange={e => set('phone', e.target.value)} style={{ width: '100%' }} />
            </div>
          </div>
        )}

        {/* Step 1: Unit Assignment */}
        {step === 1 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Assign <strong style={{ color: 'var(--text-0)' }}>{form.firstName}</strong> to a vacant unit.
            </div>

            {(units as any[]).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-3)' }}>
                <DoorOpen size={32} style={{ margin: '0 auto 8px', display: 'block', opacity: .4 }} />
                <div style={{ fontSize: '.82rem' }}>No vacant units available.</div>
                <div style={{ fontSize: '.75rem', marginTop: 4 }}>Add units first or check existing unit assignments.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                {(units as any[]).map((u: any) => (
                  <div
                    key={u.id}
                    onClick={() => set('unitId', u.id)}
                    style={{
                      padding: '12px 14px', borderRadius: 10, cursor: 'pointer', transition: 'all .12s',
                      border: `1px solid ${form.unitId === u.id ? 'var(--gold)' : 'var(--border-0)'}`,
                      background: form.unitId === u.id ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
                      display: 'flex', alignItems: 'center', gap: 12,
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                      background: form.unitId === u.id ? 'rgba(201,162,39,.15)' : 'var(--bg-3)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <DoorOpen size={16} style={{ color: form.unitId === u.id ? 'var(--gold)' : 'var(--text-3)' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>
                        Unit {u.unit_number} <span style={{ fontSize: '.72rem', color: 'var(--text-3)', fontWeight: 400 }}>· {u.property_name}</span>
                      </div>
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>
                        {u.bedrooms === 0 ? 'Studio' : `${u.bedrooms}bd`} · {u.bathrooms}ba
                        {u.sqft ? ` · ${u.sqft.toLocaleString()} sqft` : ''}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.85rem', color: 'var(--gold)', fontWeight: 600 }}>{fmt(u.rent_amount)}</div>
                      <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>/month</div>
                    </div>
                    {form.unitId === u.id && <Check size={16} style={{ color: 'var(--gold)', flexShrink: 0 }} />}
                  </div>
                ))}
              </div>
            )}
            {errors.unitId && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 8 }}>{errors.unitId}</div>}
          </div>
        )}

        {/* Step 2: Confirm */}
        {step === 2 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Review and send the invite.
            </div>

            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              {/* Tenant */}
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg, var(--gold-dark), var(--gold))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: '.8rem', fontWeight: 800, color: 'var(--bg-0)', flexShrink: 0 }}>
                  {form.firstName[0]}{form.lastName?.[0] || ''}
                </div>
                <div>
                  <div style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>{form.firstName} {form.lastName}</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{form.email}</div>
                </div>
                <span className="badge badge-amber" style={{ marginLeft: 'auto' }}>Invite Pending</span>
              </div>

              {/* Unit */}
              {selectedUnit && (
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DoorOpen size={14} style={{ color: 'var(--text-3)' }} />
                    <div>
                      <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-0)' }}>Unit {selectedUnit.unit_number}</div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{selectedUnit.property_name}</div>
                    </div>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.85rem', color: 'var(--gold)', fontWeight: 600 }}>{fmt(selectedUnit.rent_amount)}/mo</div>
                </div>
              )}

              {/* What happens next */}
              {[
                { icon: '📧', text: 'Invite email sent to tenant' },
                { icon: '🔐', text: 'Tenant sets password and verifies identity' },
                { icon: '🏦', text: 'Tenant connects bank account for ACH' },
                { icon: '✅', text: 'Unit goes active — On-Time Pay SLA begins' },
              ].map((item, i) => (
                <div key={i} style={{ padding: '8px 16px', borderBottom: i < 3 ? '1px solid var(--border-0)' : 'none', display: 'flex', alignItems: 'center', gap: 10, fontSize: '.75rem', color: 'var(--text-3)' }}>
                  <span>{item.icon}</span> {item.text}
                </div>
              ))}
            </div>

            {inviteMut.isError && (
              <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                Failed to send invite. The tenant may already be assigned to a unit.
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer" style={{ marginTop: 24 }}>
          {step > 0 ? (
            <button className="btn btn-ghost" onClick={back}><ChevronLeft size={14} /> Back</button>
          ) : (
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" onClick={next}>
              Next <ChevronRight size={14} />
            </button>
          ) : (
            <button className="btn btn-primary" onClick={submit} disabled={inviteMut.isLoading}>
              {inviteMut.isLoading ? <span className="spinner" /> : <><Mail size={14} /> Send Invite</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
