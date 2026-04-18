import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { X, Check, DollarSign, AlertTriangle } from 'lucide-react'

interface Props {
  onClose: () => void
  leaseId?: string  // if provided, modal is in edit mode
  preselectedUnitId?: string
  preselectedTenantId?: string
}

type LeaseType = 'month_to_month' | 'fixed_term' | 'nightly' | 'weekly' | 'nnn_commercial'
type AutoRenewMode = 'extend_same_term' | 'convert_to_month_to_month'

const LEASE_TYPE_LABELS: Record<LeaseType, string> = {
  month_to_month: 'Month-to-month',
  fixed_term: 'Fixed term',
  nightly: 'Nightly',
  weekly: 'Weekly',
  nnn_commercial: 'NNN Commercial',
}

const LABEL_STYLE: React.CSSProperties = {
  fontSize: '.72rem',
  fontWeight: 600,
  color: 'var(--text-3)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  display: 'block',
  marginBottom: 5,
}

const SECTION_HEADER_STYLE: React.CSSProperties = {
  fontSize: '.78rem',
  fontWeight: 700,
  color: 'var(--gold)',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  margin: '20px 0 10px 0',
  paddingBottom: 6,
  borderBottom: '1px solid var(--border-0)',
}

export function LeaseFormModal({ onClose, leaseId, preselectedUnitId, preselectedTenantId }: Props) {
  const qc = useQueryClient()
  const isEdit = Boolean(leaseId)

  // Dropdown data
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const { data: tenants = [] } = useQuery<any[]>('tenants', () => apiGet('/tenants'))

  // Existing lease (edit mode only)
  const { data: existingLease, isLoading: loadingLease } = useQuery<any>(
    ['lease', leaseId],
    () => apiGet('/leases/' + leaseId),
    { enabled: isEdit }
  )

  const [form, setForm] = useState({
    unit_id: preselectedUnitId || '',
    tenant_id: preselectedTenantId || '',
    lease_type: 'fixed_term' as LeaseType,
    start_date: '',
    end_date: '',
    rent_amount: '',
    security_deposit: '',
    auto_renew: false,
    auto_renew_mode: 'extend_same_term' as AutoRenewMode,
    notice_days_required: '30',
    expiration_notice_days: '60',
    late_fee_grace_days: '5',
    late_fee_amount: '15.00',
    status: 'pending' as 'pending' | 'active' | 'expired' | 'terminated',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<string>('')

  // Hydrate form when existing lease loads
  useEffect(() => {
    if (existingLease) {
      setForm({
        unit_id: existingLease.unit_id || '',
        tenant_id: existingLease.tenant_id || '',
        lease_type: existingLease.lease_type || 'fixed_term',
        start_date: existingLease.start_date ? String(existingLease.start_date).slice(0, 10) : '',
        end_date: existingLease.end_date ? String(existingLease.end_date).slice(0, 10) : '',
        rent_amount: existingLease.rent_amount != null ? String(existingLease.rent_amount) : '',
        security_deposit: existingLease.security_deposit != null ? String(existingLease.security_deposit) : '',
        auto_renew: Boolean(existingLease.auto_renew),
        auto_renew_mode: existingLease.auto_renew_mode || 'extend_same_term',
        notice_days_required: String(existingLease.notice_days_required ?? 30),
        expiration_notice_days: String(existingLease.expiration_notice_days ?? 60),
        late_fee_grace_days: String(existingLease.late_fee_grace_days ?? 5),
        late_fee_amount: existingLease.late_fee_amount != null ? String(existingLease.late_fee_amount) : '15.00',
        status: existingLease.status || 'pending',
      })
    }
  }, [existingLease])

  const set = (key: string, val: any) => {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => ({ ...e, [key]: '' }))
    setSubmitError('')
  }

  // When lease_type changes to month_to_month, clear end_date
  useEffect(() => {
    if (form.lease_type === 'month_to_month' && form.end_date) {
      setForm(f => ({ ...f, end_date: '' }))
    }
  }, [form.lease_type])

  const createMut = useMutation(
    (data: any) => apiPost('/leases', data),
    {
      onSuccess: () => {
        qc.invalidateQueries('leases')
        qc.invalidateQueries('units')
        onClose()
      },
      onError: (err: any) => {
        setSubmitError(err?.response?.data?.message || err?.message || 'Failed to create lease')
      }
    }
  )

  const updateMut = useMutation(
    (data: any) => apiPatch('/leases/' + leaseId, data),
    {
      onSuccess: () => {
        qc.invalidateQueries('leases')
        qc.invalidateQueries(['lease', leaseId])
        qc.invalidateQueries('units')
        onClose()
      },
      onError: (err: any) => {
        setSubmitError(err?.response?.data?.message || err?.message || 'Failed to update lease')
      }
    }
  )

  const validate = () => {
    const errs: Record<string, string> = {}
    if (!form.unit_id) errs.unit_id = 'Select a unit'
    if (!form.tenant_id) errs.tenant_id = 'Select a tenant'
    if (!form.start_date) errs.start_date = 'Start date required'
    if (form.lease_type !== 'month_to_month' && !form.end_date) {
      errs.end_date = 'End date required for ' + LEASE_TYPE_LABELS[form.lease_type].toLowerCase() + ' leases'
    }
    if (form.lease_type === 'month_to_month' && form.end_date) {
      errs.end_date = 'Month-to-month leases cannot have an end date'
    }
    if (!form.rent_amount || isNaN(Number(form.rent_amount)) || Number(form.rent_amount) <= 0) {
      errs.rent_amount = 'Valid rent required'
    }
    if (form.security_deposit && isNaN(Number(form.security_deposit))) {
      errs.security_deposit = 'Invalid amount'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const submit = () => {
    if (!validate()) return

    const payload: any = {
      leaseType: form.lease_type,
      startDate: form.start_date,
      endDate: form.lease_type === 'month_to_month' ? null : form.end_date,
      rentAmount: Number(form.rent_amount),
      securityDeposit: Number(form.security_deposit) || 0,
      autoRenew: form.auto_renew,
      autoRenewMode: form.auto_renew ? form.auto_renew_mode : null,
      noticeDaysRequired: Number(form.notice_days_required) || 30,
      expirationNoticeDays: Number(form.expiration_notice_days) || 60,
      lateFeeGraceDays: Number(form.late_fee_grace_days) || 0,
      lateFeeAmount: Number(form.late_fee_amount) || 0,
    }

    if (isEdit) {
      // On edit, include status and needsReview clearing
      payload.status = form.status
      if (existingLease?.needs_review) {
        payload.needsReview = false
      }
      updateMut.mutate(payload)
    } else {
      // On create, include unit + tenant
      payload.unitId = form.unit_id
      payload.tenantId = form.tenant_id
      createMut.mutate(payload)
    }
  }

  const isLoading = createMut.isLoading || updateMut.isLoading
  const needsReview = isEdit && existingLease?.needs_review

  // For create mode, filter units to those without an active lease
  const availableUnits = isEdit
    ? (units as any[])
    : (units as any[]).filter(u => !u.tenant_id)

  if (isEdit && loadingLease) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 560, width: '95vw' }} onClick={e => e.stopPropagation()}>
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>Loading lease…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640, width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexShrink: 0 }}>
          <div className="modal-title">{isEdit ? 'Edit Lease' : 'Add Lease'}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {/* Needs-review banner */}
        {needsReview && (
          <div style={{
            background: 'rgba(245,158,11,.08)',
            border: '1px solid var(--amber)',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 12,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          }}>
            <AlertTriangle size={16} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: '.78rem', color: 'var(--text-1)' }}>
              <strong style={{ color: 'var(--amber)' }}>Imported lease needs review.</strong> This lease was imported with default values. Please verify all fields and save to confirm.
            </div>
          </div>
        )}

        {/* Scrollable form body */}
        <div style={{ overflowY: 'auto', flex: 1, paddingRight: 4 }}>

          {/* PARTIES */}
          <div style={SECTION_HEADER_STYLE}>Parties</div>

          <div style={{ marginBottom: 14 }}>
            <label style={LABEL_STYLE}>Unit *</label>
            <select
              className="input"
              value={form.unit_id}
              onChange={e => set('unit_id', e.target.value)}
              disabled={isEdit}
              style={{ width: '100%' }}
            >
              <option value="">— Select a unit —</option>
              {availableUnits.map((u: any) => (
                <option key={u.id} value={u.id}>
                  {u.unit_number} {u.property_name ? '— ' + u.property_name : ''}
                </option>
              ))}
            </select>
            {errors.unit_id && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.unit_id}</div>}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={LABEL_STYLE}>Tenant *</label>
            <select
              className="input"
              value={form.tenant_id}
              onChange={e => set('tenant_id', e.target.value)}
              disabled={isEdit}
              style={{ width: '100%' }}
            >
              <option value="">— Select a tenant —</option>
              {(tenants as any[]).map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.first_name} {t.last_name} {t.email ? '(' + t.email + ')' : ''}
                </option>
              ))}
            </select>
            {errors.tenant_id && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.tenant_id}</div>}
          </div>

          {/* TERMS */}
          <div style={SECTION_HEADER_STYLE}>Terms</div>

          <div style={{ marginBottom: 14 }}>
            <label style={LABEL_STYLE}>Lease Type *</label>
            <select
              className="input"
              value={form.lease_type}
              onChange={e => set('lease_type', e.target.value)}
              style={{ width: '100%' }}
            >
              {(Object.keys(LEASE_TYPE_LABELS) as LeaseType[]).map(k => (
                <option key={k} value={k}>{LEASE_TYPE_LABELS[k]}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={LABEL_STYLE}>Start Date *</label>
              <input
                className="input"
                type="date"
                value={form.start_date}
                onChange={e => set('start_date', e.target.value)}
                style={{ width: '100%' }}
              />
              {errors.start_date && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.start_date}</div>}
            </div>
            <div>
              <label style={LABEL_STYLE}>
                End Date {form.lease_type !== 'month_to_month' && '*'}
              </label>
              <input
                className="input"
                type="date"
                value={form.end_date}
                onChange={e => set('end_date', e.target.value)}
                disabled={form.lease_type === 'month_to_month'}
                style={{ width: '100%' }}
                placeholder={form.lease_type === 'month_to_month' ? 'N/A' : ''}
              />
              {errors.end_date && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.end_date}</div>}
            </div>
          </div>

          {isEdit && (
            <div style={{ marginBottom: 14 }}>
              <label style={LABEL_STYLE}>Status</label>
              <select
                className="input"
                value={form.status}
                onChange={e => set('status', e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="pending">Pending</option>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
                <option value="terminated">Terminated</option>
              </select>
              {(form.status === 'expired' || form.status === 'terminated') && (
                <div style={{ fontSize: '.68rem', color: 'var(--amber)', marginTop: 4 }}>
                  Setting status to {form.status} will vacate the unit and clear the tenant.
                </div>
              )}
            </div>
          )}

          {/* RENT & DEPOSIT */}
          <div style={SECTION_HEADER_STYLE}>Rent &amp; Deposit</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={LABEL_STYLE}>Monthly Rent *</label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={form.rent_amount}
                  onChange={e => set('rent_amount', e.target.value)}
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
              {errors.rent_amount && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.rent_amount}</div>}
            </div>
            <div>
              <label style={LABEL_STYLE}>Security Deposit</label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={form.security_deposit}
                  onChange={e => set('security_deposit', e.target.value)}
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
              {errors.security_deposit && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.security_deposit}</div>}
            </div>
          </div>

          {/* RENEWAL */}
          <div style={SECTION_HEADER_STYLE}>Renewal</div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.auto_renew}
                onChange={e => set('auto_renew', e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <span style={{ fontSize: '.82rem', color: 'var(--text-1)', fontWeight: 500 }}>Enable auto-renew</span>
            </label>
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 4, marginLeft: 26 }}>
              When the lease reaches its end date, it will renew automatically per the mode below.
            </div>
          </div>

          {form.auto_renew && (
            <div style={{ marginBottom: 14, marginLeft: 26 }}>
              <label style={LABEL_STYLE}>Auto-Renew Mode</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { value: 'extend_same_term', label: 'Extend same term', desc: 'Add another term of the same length (e.g. a 12-month lease extends by 12 months)' },
                  { value: 'convert_to_month_to_month', label: 'Convert to month-to-month', desc: 'Switch to month-to-month with no fixed end date' },
                ].map(opt => (
                  <div
                    key={opt.value}
                    onClick={() => set('auto_renew_mode', opt.value)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      transition: 'all .12s',
                      border: '1px solid ' + (form.auto_renew_mode === opt.value ? 'var(--gold)' : 'var(--border-0)'),
                      background: form.auto_renew_mode === opt.value ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
                    }}
                  >
                    <div style={{ fontSize: '.78rem', fontWeight: 600, color: form.auto_renew_mode === opt.value ? 'var(--gold)' : 'var(--text-1)' }}>
                      {opt.label}
                    </div>
                    <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 2 }}>{opt.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={LABEL_STYLE}>Notice Days Required</label>
              <input
                className="input"
                type="number"
                min="0"
                value={form.notice_days_required}
                onChange={e => set('notice_days_required', e.target.value)}
                style={{ width: '100%' }}
              />
              <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 3 }}>
                Minimum days of notice either party must give to end the lease.
              </div>
            </div>
            <div>
              <label style={LABEL_STYLE}>Expiration Notice Days</label>
              <input
                className="input"
                type="number"
                min="0"
                value={form.expiration_notice_days}
                onChange={e => set('expiration_notice_days', e.target.value)}
                style={{ width: '100%' }}
              />
              <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 3 }}>
                Days before end date you want to be notified.
              </div>
            </div>
          </div>

          {/* LATE FEES */}
          <div style={SECTION_HEADER_STYLE}>Late Fees</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={LABEL_STYLE}>Grace Period (Days)</label>
              <input
                className="input"
                type="number"
                min="0"
                value={form.late_fee_grace_days}
                onChange={e => set('late_fee_grace_days', e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label style={LABEL_STYLE}>Late Fee Amount</label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  value={form.late_fee_amount}
                  onChange={e => set('late_fee_amount', e.target.value)}
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
            </div>
          </div>

          {/* DISCLAIMER */}
          <div style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--border-0)',
            borderRadius: 8,
            padding: '10px 12px',
            marginTop: 16,
            marginBottom: 8,
            fontSize: '.68rem',
            color: 'var(--text-3)',
            lineHeight: 1.5,
          }}>
            Legal notice requirements, auto-renewal rules, and late fee limits vary by jurisdiction. GAM does not provide legal advice — please check your local laws to ensure compliance.
          </div>

          {submitError && (
            <div className="alert alert-danger" style={{ marginTop: 12, fontSize: '.78rem' }}>
              {submitError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer" style={{ marginTop: 16, flexShrink: 0 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={isLoading}>
            {isLoading ? <span className="spinner" /> : <><Check size={14} /> {isEdit ? 'Save Changes' : 'Create Lease'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}
