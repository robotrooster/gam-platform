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
    unitId: preselectedUnitId || '',
    tenantId: preselectedTenantId || '',
    leaseType: 'fixed_term' as LeaseType,
    startDate: '',
    endDate: '',
    rentAmount: '',
    securityDeposit: '',
    autoRenew: false,
    autoRenewMode: 'extend_same_term' as AutoRenewMode,
    noticeDaysRequired: '30',
    expirationNoticeDays: '60',
    lateFeeGraceDays: '5',
    lateFeeAmount: '15.00',
    status: 'pending' as 'pending' | 'active' | 'expired' | 'terminated',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<string>('')

  // Hydrate form when existing lease loads
  useEffect(() => {
    if (existingLease) {
      setForm({
        unitId: existingLease.unitId || '',
        tenantId: existingLease.tenantId || '',
        leaseType: existingLease.leaseType || 'fixed_term',
        startDate: existingLease.startDate ? String(existingLease.startDate).slice(0, 10) : '',
        endDate: existingLease.endDate ? String(existingLease.endDate).slice(0, 10) : '',
        rentAmount: existingLease.rentAmount != null ? String(existingLease.rentAmount) : '',
        securityDeposit: existingLease.securityDeposit != null ? String(existingLease.securityDeposit) : '',
        autoRenew: Boolean(existingLease.autoRenew),
        autoRenewMode: existingLease.autoRenewMode || 'extend_same_term',
        noticeDaysRequired: String(existingLease.noticeDaysRequired ?? 30),
        expirationNoticeDays: String(existingLease.expirationNoticeDays ?? 60),
        lateFeeGraceDays: String(existingLease.lateFeeGraceDays ?? 5),
        lateFeeAmount: existingLease.lateFeeAmount != null ? String(existingLease.lateFeeAmount) : '15.00',
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
    if (form.leaseType === 'month_to_month' && form.endDate) {
      setForm(f => ({ ...f, endDate: '' }))
    }
  }, [form.leaseType])

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
    if (!form.unitId) errs.unitId = 'Select a unit'
    if (!form.tenantId) errs.tenantId = 'Select a tenant'
    if (!form.startDate) errs.startDate = 'Start date required'
    if (form.leaseType !== 'month_to_month' && !form.endDate) {
      errs.endDate = 'End date required for ' + LEASE_TYPE_LABELS[form.leaseType].toLowerCase() + ' leases'
    }
    if (form.leaseType === 'month_to_month' && form.endDate) {
      errs.endDate = 'Month-to-month leases cannot have an end date'
    }
    if (!form.rentAmount || isNaN(Number(form.rentAmount)) || Number(form.rentAmount) <= 0) {
      errs.rentAmount = 'Valid rent required'
    }
    if (form.securityDeposit && isNaN(Number(form.securityDeposit))) {
      errs.securityDeposit = 'Invalid amount'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const submit = () => {
    if (!validate()) return

    const payload: any = {
      leaseType: form.leaseType,
      startDate: form.startDate,
      endDate: form.leaseType === 'month_to_month' ? null : form.endDate,
      rentAmount: Number(form.rentAmount),
      securityDeposit: Number(form.securityDeposit) || 0,
      autoRenew: form.autoRenew,
      autoRenewMode: form.autoRenew ? form.autoRenewMode : null,
      noticeDaysRequired: Number(form.noticeDaysRequired) || 30,
      expirationNoticeDays: Number(form.expirationNoticeDays) || 60,
      lateFeeGraceDays: Number(form.lateFeeGraceDays) || 0,
      lateFeeAmount: Number(form.lateFeeAmount) || 0,
    }

    if (isEdit) {
      // On edit, include status and needsReview clearing
      payload.status = form.status
      if (existingLease?.needsReview) {
        payload.needsReview = false
      }
      updateMut.mutate(payload)
    } else {
      // On create, include unit + tenant
      payload.unitId = form.unitId
      payload.tenantId = form.tenantId
      createMut.mutate(payload)
    }
  }

  const isLoading = createMut.isLoading || updateMut.isLoading
  const needsReview = isEdit && existingLease?.needsReview

  // For create mode, filter units to those without an active lease
  const availableUnits = isEdit
    ? (units as any[])
    : (units as any[]).filter(u => !u.tenantId)

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
              value={form.unitId}
              onChange={e => set('unit_id', e.target.value)}
              disabled={isEdit}
              style={{ width: '100%' }}
            >
              <option value="">— Select a unit —</option>
              {availableUnits.map((u: any) => (
                <option key={u.id} value={u.id}>
                  {u.unitNumber} {u.propertyName ? '— ' + u.propertyName : ''}
                </option>
              ))}
            </select>
            {errors.unitId && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.unitId}</div>}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={LABEL_STYLE}>Tenant *</label>
            <select
              className="input"
              value={form.tenantId}
              onChange={e => set('tenant_id', e.target.value)}
              disabled={isEdit}
              style={{ width: '100%' }}
            >
              <option value="">— Select a tenant —</option>
              {(tenants as any[]).map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.firstName} {t.lastName} {t.email ? '(' + t.email + ')' : ''}
                </option>
              ))}
            </select>
            {errors.tenantId && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.tenantId}</div>}
          </div>

          {/* TERMS */}
          <div style={SECTION_HEADER_STYLE}>Terms</div>

          <div style={{ marginBottom: 14 }}>
            <label style={LABEL_STYLE}>Lease Type *</label>
            <select
              className="input"
              value={form.leaseType}
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
                value={form.startDate}
                onChange={e => set('start_date', e.target.value)}
                style={{ width: '100%' }}
              />
              {errors.startDate && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.startDate}</div>}
            </div>
            <div>
              <label style={LABEL_STYLE}>
                End Date {form.leaseType !== 'month_to_month' && '*'}
              </label>
              <input
                className="input"
                type="date"
                value={form.endDate}
                onChange={e => set('end_date', e.target.value)}
                disabled={form.leaseType === 'month_to_month'}
                style={{ width: '100%' }}
                placeholder={form.leaseType === 'month_to_month' ? 'N/A' : ''}
              />
              {errors.endDate && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.endDate}</div>}
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
                  value={form.rentAmount}
                  onChange={e => set('rent_amount', e.target.value)}
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
              {errors.rentAmount && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.rentAmount}</div>}
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
                  value={form.securityDeposit}
                  onChange={e => set('security_deposit', e.target.value)}
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
              {errors.securityDeposit && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.securityDeposit}</div>}
            </div>
          </div>

          {/* RENEWAL */}
          <div style={SECTION_HEADER_STYLE}>Renewal</div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.autoRenew}
                onChange={e => set('auto_renew', e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <span style={{ fontSize: '.82rem', color: 'var(--text-1)', fontWeight: 500 }}>Enable auto-renew</span>
            </label>
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 4, marginLeft: 26 }}>
              When the lease reaches its end date, it will renew automatically per the mode below.
            </div>
          </div>

          {form.autoRenew && (
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
                      border: '1px solid ' + (form.autoRenewMode === opt.value ? 'var(--gold)' : 'var(--border-0)'),
                      background: form.autoRenewMode === opt.value ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
                    }}
                  >
                    <div style={{ fontSize: '.78rem', fontWeight: 600, color: form.autoRenewMode === opt.value ? 'var(--gold)' : 'var(--text-1)' }}>
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
                value={form.noticeDaysRequired}
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
                value={form.expirationNoticeDays}
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
                value={form.lateFeeGraceDays}
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
                  value={form.lateFeeAmount}
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
