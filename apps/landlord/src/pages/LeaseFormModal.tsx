import { useState, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { LeaseType, LEASE_TYPE_LABEL, AutoRenewMode, AUTO_RENEW_MODES, AUTO_RENEW_MODE_LABEL, LeaseStatus, ADDENDUM_DIFF_FIELD_LABEL, formatAddendumDiffValue } from '@gam/shared'
const AUTO_RENEW_MODE_DESC: Record<AutoRenewMode, string> = {
  extend_same_term:          'Add another term of the same length (e.g. a 12-month lease extends by 12 months)',
  convert_to_month_to_month: 'Switch to month-to-month with no fixed end date',
}

import { X, Check, DollarSign, AlertTriangle } from 'lucide-react'

// S225: this modal is currently invoked in EDIT MODE ONLY. The
// landlord-portal "Add Lease" entry point was replaced with a
// /tenant-onboarding link because POST /api/leases never existed
// on the backend (e-sign, CSV import, and the lease parser are
// the live creation paths). The create-mode branches below
// (createMut, the !isEdit submit path, the `availableUnits`
// no-active-lease filter, the preselected* props, the
// seededForPropertyRef effect) are kept dormant — if a future
// session adds POST /api/leases, the modal is one entry point
// away from working again.
interface Props {
  onClose: () => void
  leaseId?: string  // if provided, modal is in edit mode
  preselectedUnitId?: string
  preselectedTenantId?: string
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
    lateFeeEnabled: true,
    lateFeeGraceDays: '5',
    lateFeeInitialAmount: '15.00',
    lateFeeInitialType: 'flat' as 'flat' | 'percent_of_rent',
    // S226: recurring accrual + cap. Toggles default off; when on,
    // amount/type/period (or amount/type for cap) get sent as a group;
    // when off, the columns get NULLed in PATCH.
    lateFeeAccrualEnabled: false,
    lateFeeAccrualAmount: '5.00',
    lateFeeAccrualType: 'flat' as 'flat' | 'percent_of_rent',
    lateFeeAccrualPeriod: 'daily' as 'daily' | 'weekly' | 'monthly',
    lateFeeCapEnabled: false,
    lateFeeCapAmount: '50.00',
    lateFeeCapType: 'flat' as 'flat' | 'percent_of_rent',
    status: 'pending' as LeaseStatus,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<string>('')

  // S224: derive the selected unit's property id from the units list,
  // then pull the property's late-fee defaults. Used for the "(from
  // property)" hint on each late-fee input. In edit mode this is
  // informational; in create mode it also seeds the form on unit pick.
  const selectedUnit = (units as any[]).find(u => u.id === form.unitId)
  const selectedPropertyId: string | undefined = selectedUnit?.propertyId
  const { data: selectedProperty } = useQuery<any>(
    ['property-late-fee', selectedPropertyId],
    () => apiGet('/properties/' + selectedPropertyId),
    { enabled: !!selectedPropertyId }
  )

  // S224: in create mode, seed the late-fee inputs from the property's
  // defaults the first time a unit is selected for a given property.
  // Edit mode skips this — the existing lease's saved values win, and
  // the property hint is informational only.
  const seededForPropertyRef = useRef<string | null>(null)
  useEffect(() => {
    if (isEdit) return
    if (!selectedProperty || !selectedPropertyId) return
    if (seededForPropertyRef.current === selectedPropertyId) return
    seededForPropertyRef.current = selectedPropertyId
    const propAccrualSet = selectedProperty.lateFeeAccrualAmount != null && selectedProperty.lateFeeAccrualType != null && selectedProperty.lateFeeAccrualPeriod != null
    const propCapSet     = selectedProperty.lateFeeCapAmount != null && selectedProperty.lateFeeCapType != null
    setForm(f => ({
      ...f,
      lateFeeEnabled: selectedProperty.lateFeeEnabled !== false,
      lateFeeGraceDays: String(selectedProperty.lateFeeGraceDays ?? 5),
      lateFeeInitialAmount: selectedProperty.lateFeeInitialAmount != null ? String(selectedProperty.lateFeeInitialAmount) : '15.00',
      lateFeeInitialType: (selectedProperty.lateFeeInitialType === 'percent_of_rent' ? 'percent_of_rent' : 'flat'),
      // S226: seed accrual + cap from property defaults too. Toggles
      // light up only when the property has all required columns set.
      lateFeeAccrualEnabled: propAccrualSet,
      lateFeeAccrualAmount: propAccrualSet ? String(selectedProperty.lateFeeAccrualAmount) : f.lateFeeAccrualAmount,
      lateFeeAccrualType:   propAccrualSet ? selectedProperty.lateFeeAccrualType : f.lateFeeAccrualType,
      lateFeeAccrualPeriod: propAccrualSet ? selectedProperty.lateFeeAccrualPeriod : f.lateFeeAccrualPeriod,
      lateFeeCapEnabled: propCapSet,
      lateFeeCapAmount: propCapSet ? String(selectedProperty.lateFeeCapAmount) : f.lateFeeCapAmount,
      lateFeeCapType:   propCapSet ? selectedProperty.lateFeeCapType : f.lateFeeCapType,
    }))
  }, [selectedProperty, selectedPropertyId, isEdit])

  // S224: hint helpers — show "(from property)" next to each late-fee
  // input whenever the form value matches the property default. The
  // hint vanishes once the landlord overrides (Q2 = b in S224 scope).
  const matchesPropertyEnabled = !!selectedProperty && form.lateFeeEnabled === (selectedProperty.lateFeeEnabled !== false)
  const matchesPropertyGrace   = !!selectedProperty && Number(form.lateFeeGraceDays) === Number(selectedProperty.lateFeeGraceDays ?? 5)
  const matchesPropertyAmount  = !!selectedProperty && Number(form.lateFeeInitialAmount) === Number(selectedProperty.lateFeeInitialAmount ?? 15)
  const matchesPropertyType    = !!selectedProperty && form.lateFeeInitialType === ((selectedProperty.lateFeeInitialType === 'percent_of_rent') ? 'percent_of_rent' : 'flat')
  // S226: hints for accrual + cap. Group-level: "(from property)"
  // shows on the toggle if both the toggle state AND every sub-field
  // matches the property; flips off the moment the landlord changes
  // any one of them.
  const propAccrualSet = !!selectedProperty && selectedProperty.lateFeeAccrualAmount != null && selectedProperty.lateFeeAccrualType != null && selectedProperty.lateFeeAccrualPeriod != null
  const propCapSet     = !!selectedProperty && selectedProperty.lateFeeCapAmount != null && selectedProperty.lateFeeCapType != null
  const matchesPropertyAccrual = !!selectedProperty &&
    form.lateFeeAccrualEnabled === propAccrualSet &&
    (!form.lateFeeAccrualEnabled || (
      Number(form.lateFeeAccrualAmount) === Number(selectedProperty.lateFeeAccrualAmount) &&
      form.lateFeeAccrualType === selectedProperty.lateFeeAccrualType &&
      form.lateFeeAccrualPeriod === selectedProperty.lateFeeAccrualPeriod
    ))
  const matchesPropertyCap = !!selectedProperty &&
    form.lateFeeCapEnabled === propCapSet &&
    (!form.lateFeeCapEnabled || (
      Number(form.lateFeeCapAmount) === Number(selectedProperty.lateFeeCapAmount) &&
      form.lateFeeCapType === selectedProperty.lateFeeCapType
    ))

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
        lateFeeEnabled: existingLease.lateFeeEnabled !== false,
        lateFeeGraceDays: String(existingLease.lateFeeGraceDays ?? 5),
        lateFeeInitialAmount: existingLease.lateFeeInitialAmount != null ? String(existingLease.lateFeeInitialAmount) : '15.00',
        lateFeeInitialType: (existingLease.lateFeeInitialType === 'percent_of_rent' ? 'percent_of_rent' : 'flat'),
        // S226: hydrate accrual + cap from the existing lease.
        lateFeeAccrualEnabled: existingLease.lateFeeAccrualAmount != null && existingLease.lateFeeAccrualType != null && existingLease.lateFeeAccrualPeriod != null,
        lateFeeAccrualAmount: existingLease.lateFeeAccrualAmount != null ? String(existingLease.lateFeeAccrualAmount) : '5.00',
        lateFeeAccrualType:   (existingLease.lateFeeAccrualType === 'percent_of_rent' ? 'percent_of_rent' : 'flat'),
        lateFeeAccrualPeriod: (['daily','weekly','monthly'].includes(existingLease.lateFeeAccrualPeriod) ? existingLease.lateFeeAccrualPeriod : 'daily'),
        lateFeeCapEnabled: existingLease.lateFeeCapAmount != null && existingLease.lateFeeCapType != null,
        lateFeeCapAmount: existingLease.lateFeeCapAmount != null ? String(existingLease.lateFeeCapAmount) : '50.00',
        lateFeeCapType:   (existingLease.lateFeeCapType === 'percent_of_rent' ? 'percent_of_rent' : 'flat'),
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

  // S201: 409 from PATCH with material_change_requires_new_lease or
  // addendum_confirmation_required. Surface lives in the modal below
  // the form fields. State holds the change list returned by the
  // server so the user sees exactly what they're confirming.
  const [pendingConfirm, setPendingConfirm] = useState<{
    kind: 'material' | 'addendum'
    message: string
    changes: Array<{ field: string; from: string; to: string }>
    payload: any
  } | null>(null)

  // S202: humanize backend snake_case field names for the diff.
  const FIELD_LABEL: Record<string, string> = {
    rent_amount:            'Monthly rent',
    start_date:             'Start date',
    end_date:               'End date',
    lease_type:             'Lease type',
    auto_renew:             'Auto-renew',
    auto_renew_mode:        'Auto-renew mode',
    late_fee_grace_days:    'Late fee grace days',
    late_fee_initial_amount:'Late fee amount',
    late_fee_initial_type:  'Late fee type',
    late_fee_enabled:       'Late fees enabled',
    late_fee_accrual_amount:'Recurring accrual amount',
    late_fee_accrual_type:  'Recurring accrual type',
    late_fee_accrual_period:'Recurring accrual period',
    late_fee_cap_amount:    'Maximum cap amount',
    late_fee_cap_type:      'Maximum cap type',
    notice_days_required:   'Notice days required',
    expiration_notice_days: 'Expiration notice days',
    security_deposit:       'Security deposit',
  }

  const updateMut = useMutation(
    (data: any) => apiPatch('/leases/' + leaseId, data),
    {
      onSuccess: () => {
        qc.invalidateQueries('leases')
        qc.invalidateQueries(['lease', leaseId])
        qc.invalidateQueries('units')
        setPendingConfirm(null)
        onClose()
      },
      onError: (err: any) => {
        const data = err?.response?.data
        if (data?.error === 'material_change_requires_new_lease') {
          setPendingConfirm({
            kind: 'material',
            message: data.message,
            changes: data.changes ?? [],
            payload: null,
          })
          setSubmitError('')
          return
        }
        if (data?.error === 'addendum_confirmation_required') {
          setPendingConfirm({
            kind: 'addendum',
            message: data.message,
            changes: data.changes ?? [],
            // Stash the original payload so retry can re-send with confirmAddendum.
            payload: err?.config?.data ? JSON.parse(err.config.data) : null,
          })
          setSubmitError('')
          return
        }
        setSubmitError(data?.message || err?.message || 'Failed to update lease')
      }
    }
  )

  const validate = () => {
    const errs: Record<string, string> = {}
    if (!form.unitId) errs.unitId = 'Select a unit'
    if (!form.tenantId) errs.tenantId = 'Select a tenant'
    if (!form.startDate) errs.startDate = 'Start date required'
    if (form.leaseType !== 'month_to_month' && !form.endDate) {
      errs.endDate = 'End date required for ' + LEASE_TYPE_LABEL[form.leaseType].toLowerCase() + ' leases'
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
      lateFeeEnabled: form.lateFeeEnabled,
      lateFeeGraceDays: Number(form.lateFeeGraceDays) || 0,
      lateFeeInitialAmount: Number(form.lateFeeInitialAmount) || 0,
      lateFeeInitialType: form.lateFeeInitialType,
      // S226: accrual + cap. Toggle off → null the columns; toggle on
      // → send the parsed group. Server-side cross-field validation
      // also enforces all-or-nothing.
      lateFeeAccrualAmount: form.lateFeeAccrualEnabled ? Number(form.lateFeeAccrualAmount) || 0 : null,
      lateFeeAccrualType:   form.lateFeeAccrualEnabled ? form.lateFeeAccrualType   : null,
      lateFeeAccrualPeriod: form.lateFeeAccrualEnabled ? form.lateFeeAccrualPeriod : null,
      lateFeeCapAmount:     form.lateFeeCapEnabled     ? Number(form.lateFeeCapAmount) || 0 : null,
      lateFeeCapType:       form.lateFeeCapEnabled     ? form.lateFeeCapType         : null,
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
              onChange={e => set('unitId', e.target.value)}
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
              onChange={e => set('tenantId', e.target.value)}
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
              onChange={e => set('leaseType', e.target.value)}
              style={{ width: '100%' }}
            >
              {(Object.keys(LEASE_TYPE_LABEL) as LeaseType[]).map(k => (
                <option key={k} value={k}>{LEASE_TYPE_LABEL[k]}</option>
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
                onChange={e => set('startDate', e.target.value)}
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
                onChange={e => set('endDate', e.target.value)}
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
                  onChange={e => set('rentAmount', e.target.value)}
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
                  onChange={e => set('securityDeposit', e.target.value)}
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
                onChange={e => set('autoRenew', e.target.checked)}
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
                  ...AUTO_RENEW_MODES.map(value => ({ value, label: AUTO_RENEW_MODE_LABEL[value], desc: AUTO_RENEW_MODE_DESC[value] })),
                ].map(opt => (
                  <div
                    key={opt.value}
                    onClick={() => set('autoRenewMode', opt.value)}
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
                onChange={e => set('noticeDaysRequired', e.target.value)}
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
                onChange={e => set('expirationNoticeDays', e.target.value)}
                style={{ width: '100%' }}
              />
              <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 3 }}>
                Days before end date you want to be notified.
              </div>
            </div>
          </div>

          {/* LATE FEES — S224: 4 fields (enabled + grace + amount + type),
              with "(from property)" hints when value matches property default. */}
          <div style={SECTION_HEADER_STYLE}>Late Fees</div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.lateFeeEnabled}
                onChange={e => set('lateFeeEnabled', e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <span style={{ fontSize: '.82rem', color: 'var(--text-1)', fontWeight: 500 }}>Late fees enabled</span>
              {matchesPropertyEnabled && (
                <span style={{ fontSize: '.65rem', color: 'var(--text-3)', fontStyle: 'italic' }}>(from property)</span>
              )}
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14, opacity: form.lateFeeEnabled ? 1 : 0.5 }}>
            <div>
              <label style={LABEL_STYLE}>
                Grace Period (Days)
                {matchesPropertyGrace && form.lateFeeEnabled && (
                  <span style={{ marginLeft: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)', fontStyle: 'italic' }}>
                    (from property)
                  </span>
                )}
              </label>
              <input
                className="input"
                type="number"
                min="0"
                value={form.lateFeeGraceDays}
                onChange={e => set('lateFeeGraceDays', e.target.value)}
                disabled={!form.lateFeeEnabled}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label style={LABEL_STYLE}>
                Late Fee Amount
                {matchesPropertyAmount && form.lateFeeEnabled && (
                  <span style={{ marginLeft: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)', fontStyle: 'italic' }}>
                    (from property)
                  </span>
                )}
              </label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  value={form.lateFeeInitialAmount}
                  onChange={e => set('lateFeeInitialAmount', e.target.value)}
                  disabled={!form.lateFeeEnabled}
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
            </div>
            <div>
              <label style={LABEL_STYLE}>
                Fee Type
                {matchesPropertyType && form.lateFeeEnabled && (
                  <span style={{ marginLeft: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)', fontStyle: 'italic' }}>
                    (from property)
                  </span>
                )}
              </label>
              <select
                className="input"
                value={form.lateFeeInitialType}
                onChange={e => set('lateFeeInitialType', e.target.value as 'flat' | 'percent_of_rent')}
                disabled={!form.lateFeeEnabled}
                style={{ width: '100%' }}
              >
                <option value="flat">Flat $</option>
                <option value="percent_of_rent">% of rent</option>
              </select>
            </div>
          </div>

          {/* S226: recurring accrual toggle + 3 inputs. Disabled when
              parent late-fee toggle is off. */}
          <div style={{ marginTop: 4, marginBottom: 12, opacity: form.lateFeeEnabled ? 1 : 0.4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: form.lateFeeEnabled ? 'pointer' : 'not-allowed' }}>
              <input
                type="checkbox"
                checked={form.lateFeeAccrualEnabled}
                disabled={!form.lateFeeEnabled}
                onChange={e => set('lateFeeAccrualEnabled', e.target.checked)}
                style={{ width: 16, height: 16, cursor: form.lateFeeEnabled ? 'pointer' : 'not-allowed' }}
              />
              <span style={{ fontSize: '.78rem', color: 'var(--text-1)', fontWeight: 600 }}>Recurring accrual</span>
              <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>(continues to add up after the initial fee)</span>
              {matchesPropertyAccrual && (
                <span style={{ fontSize: '.65rem', color: 'var(--text-3)', fontStyle: 'italic' }}>(from property)</span>
              )}
            </label>
            {form.lateFeeAccrualEnabled && form.lateFeeEnabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 8 }}>
                <div>
                  <label style={LABEL_STYLE}>Amount per period</label>
                  <div style={{ position: 'relative' }}>
                    <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      min="0"
                      value={form.lateFeeAccrualAmount}
                      onChange={e => set('lateFeeAccrualAmount', e.target.value)}
                      style={{ width: '100%', paddingLeft: 30 }}
                    />
                  </div>
                </div>
                <div>
                  <label style={LABEL_STYLE}>Type</label>
                  <select
                    className="input"
                    value={form.lateFeeAccrualType}
                    onChange={e => set('lateFeeAccrualType', e.target.value as 'flat' | 'percent_of_rent')}
                    style={{ width: '100%' }}
                  >
                    <option value="flat">Flat $</option>
                    <option value="percent_of_rent">% of rent</option>
                  </select>
                </div>
                <div>
                  <label style={LABEL_STYLE}>Period</label>
                  <select
                    className="input"
                    value={form.lateFeeAccrualPeriod}
                    onChange={e => set('lateFeeAccrualPeriod', e.target.value as 'daily' | 'weekly' | 'monthly')}
                    style={{ width: '100%' }}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* S226: maximum cap toggle + 2 inputs. Cap-edge writes a
              partial row of exactly the remaining amount, then stops
              (locked S26b decision). Independent of accrual. */}
          <div style={{ marginBottom: 14, opacity: form.lateFeeEnabled ? 1 : 0.4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: form.lateFeeEnabled ? 'pointer' : 'not-allowed' }}>
              <input
                type="checkbox"
                checked={form.lateFeeCapEnabled}
                disabled={!form.lateFeeEnabled}
                onChange={e => set('lateFeeCapEnabled', e.target.checked)}
                style={{ width: 16, height: 16, cursor: form.lateFeeEnabled ? 'pointer' : 'not-allowed' }}
              />
              <span style={{ fontSize: '.78rem', color: 'var(--text-1)', fontWeight: 600 }}>Maximum cap</span>
              <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>(total late fees per invoice cannot exceed this)</span>
              {matchesPropertyCap && (
                <span style={{ fontSize: '.65rem', color: 'var(--text-3)', fontStyle: 'italic' }}>(from property)</span>
              )}
            </label>
            {form.lateFeeCapEnabled && form.lateFeeEnabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                <div>
                  <label style={LABEL_STYLE}>Cap amount</label>
                  <div style={{ position: 'relative' }}>
                    <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      min="0"
                      value={form.lateFeeCapAmount}
                      onChange={e => set('lateFeeCapAmount', e.target.value)}
                      style={{ width: '100%', paddingLeft: 30 }}
                    />
                  </div>
                </div>
                <div>
                  <label style={LABEL_STYLE}>Cap type</label>
                  <select
                    className="input"
                    value={form.lateFeeCapType}
                    onChange={e => set('lateFeeCapType', e.target.value as 'flat' | 'percent_of_rent')}
                    style={{ width: '100%' }}
                  >
                    <option value="flat">Flat $</option>
                    <option value="percent_of_rent">% of rent</option>
                  </select>
                </div>
              </div>
            )}
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

          {/* S211: addendum history — landlord parity with the tenant
              LeasePage section shipped S210. Surfaces past non-material
              edits recorded against this lease. Edit-mode only; renders
              nothing when no addendums exist. */}
          {isEdit && leaseId && (
            <AddendumHistorySection leaseId={leaseId} />
          )}

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

      {/* S201: confirmation overlay for material vs non-material edits. */}
      {pendingConfirm && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setPendingConfirm(null)}
        >
          <div className="card" style={{ width: 520, maxWidth: '92vw', padding: 20 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 10 }}>
              {pendingConfirm.kind === 'material' ? 'New lease required' : 'Addendum confirmation'}
            </h3>
            <div style={{ fontSize: '.85rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.55 }}>
              {pendingConfirm.message}
            </div>

            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: 10, marginBottom: 14 }}>
              <div style={{ fontSize: '.7rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                Changes
              </div>
              {pendingConfirm.changes.map(c => (
                <div key={c.field} style={{ display: 'flex', gap: 8, fontSize: '.8rem', padding: '3px 0', alignItems: 'baseline' }}>
                  <span style={{ flex: '0 0 180px', color: 'var(--text-2)' }}>{FIELD_LABEL[c.field] ?? c.field}</span>
                  <span style={{ color: 'var(--text-3)' }}>{c.from || '—'}</span>
                  <span style={{ color: 'var(--text-3)' }}>→</span>
                  <span style={{ color: 'var(--text-0)', fontWeight: 600 }}>{c.to || '—'}</span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPendingConfirm(null)}>Cancel</button>
              {pendingConfirm.kind === 'addendum' ? (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    if (pendingConfirm.payload) {
                      updateMut.mutate({ ...pendingConfirm.payload, confirmAddendum: true })
                    }
                  }}
                  disabled={updateMut.isLoading}
                >
                  {updateMut.isLoading ? <span className="spinner" /> : 'Confirm — record addendum'}
                </button>
              ) : (
                // Material — no in-place confirm path; landlord must use new-lease workflow.
                <button className="btn btn-primary" disabled>
                  Use Tenant Onboarding
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── ADDENDUM HISTORY (S211 — landlord-side parity with S210 tenant view) ──
// S212: field-label + money-formatting moved to @gam/shared so the
// API PDF generator + tenant surface read the same map.
// S213: pdf_filename → "View PDF" link, served via
// /api/leases/:id/addendum-pdf/:filename. Browser <a> can't carry
// the Bearer token, so the click handler fetches with auth and
// opens a blob URL in a new tab.
type AddendumChange = { field: string; from: string; to: string }
type AddendumEvent  = {
  id:                  string
  occurredAt:          string
  changes:             AddendumChange[]
  tenantIds:           string[]
  tenantNames:         string[]
  recordedByUserId:    string | null
  recordedByName:      string
  recordedByRole:      'owner' | 'gam_admin' | 'pm' | 'team' | 'unknown'
  recordedByRoleLabel: string
  pdfFilename:         string | null
}

const ADDENDUM_API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

async function openLandlordAddendumPdf(leaseId: string, filename: string) {
  const token = localStorage.getItem('gam_token') || ''
  const res = await fetch(`${ADDENDUM_API_BASE}/api/leases/${leaseId}/addendum-pdf/${filename}`, {
    headers: { Authorization: 'Bearer ' + token },
  })
  if (!res.ok) {
    alert('Could not load PDF (status ' + res.status + ')')
    return
  }
  const blob = await res.blob()
  window.open(URL.createObjectURL(blob), '_blank')
}

function AddendumHistorySection({ leaseId }: { leaseId: string }) {
  const { data, isLoading } = useQuery(
    ['lease-addendums', leaseId],
    () => apiGet('/leases/' + leaseId + '/addendums')
  )
  const addendums: AddendumEvent[] = (data as AddendumEvent[] | undefined) ?? []

  if (isLoading || addendums.length === 0) return null

  return (
    <div style={{
      marginTop: 12,
      padding: 14,
      background: 'var(--bg-2)',
      border: '1px solid var(--border-0)',
      borderRadius: 8,
    }}>
      <div style={{
        fontSize: '.7rem',
        fontWeight: 700,
        color: 'var(--text-3)',
        textTransform: 'uppercase',
        letterSpacing: '.07em',
        marginBottom: 10,
      }}>
        Addendum History ({addendums.length})
      </div>
      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 12 }}>
        Past non-material edits recorded against this lease. Each row is part of the tenants' tenancy record.
      </div>
      {addendums.map(a => (
        <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-0)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '.76rem', fontWeight: 600, color: 'var(--text-0)' }}>
              {new Date(a.occurredAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
            </span>
            <span style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>
              {new Date(a.occurredAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
            {a.pdfFilename && (
              <button
                onClick={() => openLandlordAddendumPdf(leaseId, a.pdfFilename!)}
                style={{ marginLeft: 'auto', fontSize: '.66rem', padding: '2px 8px', background: 'transparent', border: '1px solid var(--gold)', color: 'var(--gold)', borderRadius: 4, cursor: 'pointer' }}>
                View PDF
              </button>
            )}
          </div>
          <div style={{ fontSize: '.66rem', color: 'var(--text-3)', marginBottom: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span>Recorded by <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>{a.recordedByName}</span></span>
            <span>· {a.recordedByRoleLabel}</span>
            <span>· On record for {a.tenantNames.length > 0 ? a.tenantNames.join(', ') : '(no active tenants)'}</span>
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            {(a.changes ?? []).map((c, i) => (
              <div key={i} style={{
                fontSize: '.72rem',
                color: 'var(--text-2)',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                alignItems: 'baseline',
              }}>
                <span style={{ fontWeight: 600, color: 'var(--text-1)' }}>
                  {ADDENDUM_DIFF_FIELD_LABEL[c.field] ?? c.field}
                </span>
                <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-m, monospace)' }}>
                  {formatAddendumDiffValue(c.field, c.from)}
                </span>
                <span style={{ color: 'var(--text-3)' }}>→</span>
                <span style={{
                  color: 'var(--gold)',
                  fontFamily: 'var(--font-m, monospace)',
                  fontWeight: 600,
                }}>
                  {formatAddendumDiffValue(c.field, c.to)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
