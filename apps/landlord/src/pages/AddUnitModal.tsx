import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { X, Building2, DoorOpen, DollarSign, ChevronRight, ChevronLeft, Check } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

interface Props { onClose: () => void; preselectedPropertyId?: string }

const STEPS = ['Property', 'Unit Details', 'Pricing', 'Review']

export function AddUnitModal({ onClose, preselectedPropertyId }: Props) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [step, setStep] = useState(preselectedPropertyId ? 1 : 0)
  const [form, setForm] = useState({
    property_id:      preselectedPropertyId || '',
    unit_number:      '',
    bedrooms:         1,
    bathrooms:        1,
    sqft:             '',
    rent_amount:      '',
    security_deposit: '',
    status:           'vacant',
    listed_vacant:    true,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))

  const createMut = useMutation(
    (data: any) => apiPost('/units', data),
    {
      onSuccess: (res: any) => {
        qc.invalidateQueries('units')
        onClose()
        navigate(`/units/${res.data.id}`)
      }
    }
  )

  const selectedProperty = (properties as any[]).find(p => p.id === form.property_id)

  const set = (key: string, val: any) => {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => ({ ...e, [key]: '' }))
  }

  const validateStep = () => {
    const errs: Record<string, string> = {}
    if (step === 0 && !form.property_id) errs.property_id = 'Select a property'
    if (step === 1 && !form.unit_number.trim()) errs.unit_number = 'Unit number required'
    if (step === 2) {
      if (!form.rent_amount || isNaN(Number(form.rent_amount)) || Number(form.rent_amount) <= 0)
        errs.rent_amount = 'Valid rent amount required'
      if (form.security_deposit && isNaN(Number(form.security_deposit)))
        errs.security_deposit = 'Invalid amount'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const next = () => { if (validateStep()) setStep(s => s + 1) }
  const back = () => setStep(s => s - 1)

  const submit = () => {
    createMut.mutate({
      propertyId:      form.property_id,
      unitNumber:      form.unit_number.trim(),
      bedrooms:         Number(form.bedrooms),
      bathrooms:        Number(form.bathrooms),
      sqft:             form.sqft ? Number(form.sqft) : null,
      rentAmount:      Number(form.rent_amount),
      securityDeposit: Number(form.security_deposit) || 0,
      status:           form.status,
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520, width: '95vw' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div className="modal-title" style={{ marginBottom: 4 }}>Add Unit</div>
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

        {/* Step 0: Property */}
        {step === 0 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Which property is this unit in?
            </div>
            {(properties as any[]).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-3)' }}>
                <Building2 size={32} style={{ margin: '0 auto 8px', display: 'block', opacity: .4 }} />
                <div style={{ fontSize: '.82rem' }}>No properties yet.</div>
                <div style={{ fontSize: '.75rem', marginTop: 4 }}>Add a property first before adding units.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(properties as any[]).map((p: any) => (
                  <div
                    key={p.id}
                    onClick={() => set('property_id', p.id)}
                    style={{
                      padding: '12px 14px', borderRadius: 10, cursor: 'pointer', transition: 'all .12s',
                      border: `1px solid ${form.property_id === p.id ? 'var(--gold)' : 'var(--border-0)'}`,
                      background: form.property_id === p.id ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
                      display: 'flex', alignItems: 'center', gap: 12,
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                      background: form.property_id === p.id ? 'rgba(201,162,39,.15)' : 'var(--bg-3)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Building2 size={16} style={{ color: form.property_id === p.id ? 'var(--gold)' : 'var(--text-3)' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>{p.name}</div>
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>{p.street1}, {p.city}, {p.state}</div>
                    </div>
                    {form.property_id === p.id && <Check size={16} style={{ color: 'var(--gold)', flexShrink: 0 }} />}
                  </div>
                ))}
              </div>
            )}
            {errors.property_id && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 8 }}>{errors.property_id}</div>}
          </div>
        )}

        {/* Step 1: Unit Details */}
        {step === 1 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Tell us about the unit at <strong style={{ color: 'var(--text-0)' }}>{selectedProperty?.name}</strong>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
                Unit Number / Identifier *
              </label>
              <input
                className="input"
                placeholder="e.g. 101, A1, Site 42, Lot 7"
                value={form.unit_number}
                onChange={e => set('unit_number', e.target.value)}
                autoFocus
                style={{ width: '100%' }}
              />
              {errors.unit_number && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.unit_number}</div>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Bedrooms</label>
                <select className="input" value={form.bedrooms} onChange={e => set('bedrooms', e.target.value)} style={{ width: '100%' }}>
                  {[0,1,2,3,4,5,6].map(n => <option key={n} value={n}>{n === 0 ? 'Studio' : n}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Bathrooms</label>
                <select className="input" value={form.bathrooms} onChange={e => set('bathrooms', e.target.value)} style={{ width: '100%' }}>
                  {[1, 1.5, 2, 2.5, 3, 3.5, 4].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Sq Ft</label>
                <input
                  className="input"
                  type="number"
                  placeholder="850"
                  value={form.sqft}
                  onChange={e => set('sqft', e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Initial Status</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { value: 'vacant', label: 'Vacant', desc: 'No tenant, $0 charge', color: 'var(--text-3)' },
                  { value: 'active', label: 'Active', desc: 'Occupied, On-Time Pay', color: 'var(--green)' },
                  { value: 'direct_pay', label: 'Direct Pay', desc: 'Tenant pays landlord', color: 'var(--blue)' },
                ].map(s => (
                  <div
                    key={s.value}
                    onClick={() => set('status', s.value)}
                    style={{
                      padding: '10px 12px', borderRadius: 8, cursor: 'pointer', transition: 'all .12s',
                      border: `1px solid ${form.status === s.value ? s.color : 'var(--border-0)'}`,
                      background: form.status === s.value ? `${s.color}12` : 'var(--bg-2)',
                    }}
                  >
                    <div style={{ fontSize: '.78rem', fontWeight: 600, color: form.status === s.value ? s.color : 'var(--text-1)' }}>{s.label}</div>
                    <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 2 }}>{s.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Pricing */}
        {step === 2 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Set the rent and deposit for unit <strong style={{ color: 'var(--text-0)' }}>{form.unit_number}</strong>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
                Monthly Rent *
              </label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input
                  className="input"
                  type="number"
                  placeholder="0.00"
                  value={form.rent_amount}
                  onChange={e => set('rent_amount', e.target.value)}
                  autoFocus
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
              {errors.rent_amount && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.rent_amount}</div>}
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
                Security Deposit
              </label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input
                  className="input"
                  type="number"
                  placeholder="0.00"
                  value={form.security_deposit}
                  onChange={e => set('security_deposit', e.target.value)}
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
              {errors.security_deposit && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.security_deposit}</div>}
            </div>

          </div>
        )}

        {/* Step 3: Review */}
        {step === 3 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Review the unit details before saving.
            </div>

            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              {/* Header */}
              <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(201,162,39,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <DoorOpen size={16} style={{ color: 'var(--gold)' }} />
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)' }}>
                    Unit {form.unit_number}
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{selectedProperty?.name}</div>
                </div>
                <span className={`badge ${form.status === 'active' ? 'badge-green' : form.status === 'direct_pay' ? 'badge-blue' : 'badge-muted'}`} style={{ marginLeft: 'auto' }}>
                  {form.status.replace('_', ' ')}
                </span>
              </div>

              {/* Details */}
              {[
                { label: 'Property', val: `${selectedProperty?.name} — ${selectedProperty?.street1}` },
                { label: 'Bedrooms', val: form.bedrooms === 0 ? 'Studio' : `${form.bedrooms} bed` },
                { label: 'Bathrooms', val: `${form.bathrooms} bath` },
                form.sqft ? { label: 'Square feet', val: `${Number(form.sqft).toLocaleString()} sq ft` } : null,
                { label: 'Monthly rent', val: fmt(Number(form.rent_amount)) },
                { label: 'Security deposit', val: form.security_deposit ? fmt(Number(form.security_deposit)) : '$0.00' },
                { label: 'Platform fee', val: '$15.00/month' },
              ].filter(Boolean).map((row: any) => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid var(--border-0)', fontSize: '.78rem' }}>
                  <span style={{ color: 'var(--text-3)' }}>{row.label}</span>
                  <span style={{ color: 'var(--text-0)', fontWeight: 500 }}>{row.val}</span>
                </div>
              ))}
            </div>

            {createMut.isError && (
              <div className="alert alert-danger" style={{ marginBottom: 12 }}>
                Failed to create unit. Please try again.
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer" style={{ marginTop: 24 }}>
          {step > 0 ? (
            <button className="btn btn-ghost" onClick={back}>
              <ChevronLeft size={14} /> Back
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          )}

          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" onClick={next} disabled={step === 0 && !form.property_id}>
              Next <ChevronRight size={14} />
            </button>
          ) : (
            <button className="btn btn-primary" onClick={submit} disabled={createMut.isLoading}>
              {createMut.isLoading ? <span className="spinner" /> : <><Check size={14} /> Create Unit</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
