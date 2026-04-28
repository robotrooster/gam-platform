import { useState, useRef, useMemo } from 'react'
import { useMutation } from 'react-query'
import { Upload, Download, FileText, AlertCircle, CheckCircle2, AlertTriangle, ArrowUp, X } from 'lucide-react'
import { apiPost } from '../lib/api'

// Backend response shape from POST /onboard-tenants-csv/validate.
type CsvIssue = { severity: 'block' | 'warn'; field?: string; message: string }
type CsvRow = {
  rowIndex: number
  firstName: string
  lastName: string
  email: string
  phone: string
  propertyName: string
  unitNumber: string
  leaseStart: string
  leaseEnd: string
  monthlyRent: string
  securityDeposit: string
  lateFeeAmount: string
  lateFeeGraceDays: string
  autoRenew: string
  autoRenewMode: string
  noticeDaysRequired: string
  resolvedUnitId?: string
  resolvedExistingUserId?: string
  resolvedExistingTenantId?: string
  issues: CsvIssue[]
}
type ValidateResponse = {
  rows: CsvRow[]
  summary: { total: number; blockers: number; warnings: number; ready: number }
}
type CommitResponse = {
  committed: number
  leases: number
  tenants: { email: string; tenantId: string; leaseId: string }[]
}

// Backend issue.field is snake_case; row state keys are camelCase. Map.
const FIELD_TO_ISSUE_KEY: Record<string, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  propertyName: 'property_name',
  unitNumber: 'unit_number',
  leaseStart: 'lease_start',
  leaseEnd: 'lease_end',
  monthlyRent: 'monthly_rent',
  securityDeposit: 'security_deposit',
  lateFeeAmount: 'late_fee_amount',
  lateFeeGraceDays: 'late_fee_grace_days',
  autoRenew: 'auto_renew',
  autoRenewMode: 'auto_renew_mode',
  noticeDaysRequired: 'notice_days_required',
}

const PLATFORM_OPTIONS = [
  { value: 'generic',     label: 'Generic (GAM template)', enabled: true },
  { value: 'buildium',    label: 'Buildium',               enabled: false },
  { value: 'appfolio',    label: 'AppFolio',               enabled: false },
  { value: 'doorloop',    label: 'DoorLoop',               enabled: false },
  { value: 'yardi',       label: 'Yardi',                  enabled: false },
  { value: 'rentmanager', label: 'RentManager',            enabled: false },
  { value: 'propertyware',label: 'Propertyware',           enabled: false },
  { value: 'rentec',      label: 'Rentec Direct',          enabled: false },
  { value: 'tenantcloud', label: 'TenantCloud',            enabled: false },
]

type Mode = 'choose' | 'bulk' | 'single'

export function TenantOnboardingPage() {
  const [mode, setMode] = useState<Mode>('choose')

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-0)', margin: 0 }}>
          Tenant Onboarding
        </h1>
        <p style={{ fontSize: '.88rem', color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 }}>
          Bring tenants who already live in your units onto GAM. No application or
          background check is required because they are already living there.
        </p>
      </div>

      {mode === 'choose' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <button
            onClick={() => setMode('bulk')}
            style={{ textAlign: 'left', padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', cursor: 'pointer' }}
          >
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)', marginBottom: 6 }}>Bulk CSV Import</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              Upload a spreadsheet of existing tenants and their leases. Best for
              migrating from another platform.
            </div>
          </button>

          <button
            onClick={() => setMode('single')}
            style={{ textAlign: 'left', padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', cursor: 'pointer' }}
          >
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)', marginBottom: 6 }}>Add One Tenant</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              Type a single tenant info and lease terms. Best for adding one tenant
              at a time.
            </div>
          </button>
        </div>
      )}

      {mode === 'bulk' && <BulkCsvMode onBack={() => setMode('choose')} />}

      {mode === 'single' && (
        <div>
          <button onClick={() => setMode('choose')} className="btn btn-ghost" style={{ marginBottom: 16 }}>
            &larr; Back
          </button>
          <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)' }}>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)', marginBottom: 8 }}>
              Coming soon
            </div>
            <p style={{ fontSize: '.88rem', color: 'var(--text-2)', lineHeight: 1.6, marginTop: 0, marginBottom: 12 }}>
              Add a tenant by name, email, and phone. They land in a pending pool until you upload their lease PDF. The system reads the PDF, fills in the unit and lease terms automatically, and flags any mismatches before activating the tenant. No retyping data that already lives on the lease.
            </p>
            <p style={{ fontSize: '.82rem', color: 'var(--text-3)', lineHeight: 1.6, marginTop: 0, marginBottom: 0 }}>
              For now, use Bulk CSV Import to onboard existing tenants. The PDF-driven flow ships in the next release.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// Split rows into fast-path (clean unit groups) and dirty (units with at least one blocker).
// Rows without resolvedUnitId always go to dirty so the punch list can surface them.
function splitFastPath(rows: CsvRow[]): { fastPathRows: CsvRow[]; dirtyRows: CsvRow[] } {
  const byUnit = new Map<string, CsvRow[]>()
  const orphans: CsvRow[] = []
  for (const r of rows) {
    if (!r.resolvedUnitId) { orphans.push(r); continue }
    if (!byUnit.has(r.resolvedUnitId)) byUnit.set(r.resolvedUnitId, [])
    byUnit.get(r.resolvedUnitId)!.push(r)
  }

  const fastPathRows: CsvRow[] = []
  const dirtyRows: CsvRow[] = [...orphans]
  for (const [, groupRows] of byUnit) {
    const hasBlocker = groupRows.some(r => r.issues.some(i => i.severity === 'block'))
    if (hasBlocker) dirtyRows.push(...groupRows)
    else fastPathRows.push(...groupRows)
  }
  return { fastPathRows, dirtyRows }
}

function BulkCsvMode({ onBack }: { onBack: () => void }) {
  const [source, setSource] = useState<string>('generic')
  const [fileName, setFileName] = useState<string>('')
  const [csvText, setCsvText] = useState<string>('')
  const [punchListRows, setPunchListRows] = useState<CsvRow[] | null>(null)
  const [validateSummary, setValidateSummary] = useState<{ total: number; blockers: number; warnings: number; ready: number } | null>(null)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [fastPathBanner, setFastPathBanner] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const validateMut = useMutation(
    (body: { csv: string; source: string }) => apiPost<ValidateResponse>('/landlords/me/onboard-tenants-csv/validate', body),
    {
      onSuccess: async (res: any) => {
        const data: ValidateResponse = res.data
        setErrorMsg('')
        setValidateSummary(data.summary)

        const { fastPathRows, dirtyRows } = splitFastPath(data.rows)
        if (fastPathRows.length > 0) {
          try {
            const commitRes: any = await apiPost<CommitResponse>('/landlords/me/onboard-tenants-csv/commit', { rows: fastPathRows })
            const c: CommitResponse = commitRes.data
            const tenantWord = c.committed === 1 ? 'tenant' : 'tenants'
            const unitWord = c.leases === 1 ? 'unit' : 'units'
            setFastPathBanner(`${c.committed} ${tenantWord} onboarded across ${c.leases} ${unitWord}. Activation emails sent.`)
            setPunchListRows(dirtyRows)
          } catch (e: any) {
            // Fast-path failure: roll all rows into the punch list so landlord can fix.
            setErrorMsg(e?.response?.data?.message || 'Some rows could not be auto-onboarded. Review below.')
            setPunchListRows(data.rows)
          }
        } else {
          setPunchListRows(dirtyRows)
        }
      },
      onError: (err: any) => {
        setErrorMsg(err?.response?.data?.message || 'Validation failed. Check the CSV format and try again.')
        setPunchListRows(null)
        setValidateSummary(null)
      },
    }
  )

  const handleFile = (file: File) => {
    setFileName(file.name)
    setErrorMsg('')
    setPunchListRows(null)
    setValidateSummary(null)
    setFastPathBanner('')
    const reader = new FileReader()
    reader.onload = (e) => setCsvText(String(e.target?.result || ''))
    reader.onerror = () => setErrorMsg('Could not read the file. Try again.')
    reader.readAsText(file)
  }

  const handleDownloadTemplate = async () => {
    // Raw fetch (not apiGet) because the response is text/csv, not JSON.
    // apiGet/apiPost both parse response.data.data; this needs a blob.
    try {
      const apiUrl = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
      const token = localStorage.getItem('gam_token')
      const res = await fetch(`${apiUrl}/api/landlords/me/onboard-tenants-csv/template?source=generic`, {
        headers: { Authorization: 'Bearer ' + token },
      })
      if (!res.ok) { setErrorMsg('Could not download the template.'); return }
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'gam-tenant-onboarding-template.csv'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      setErrorMsg('Could not download the template.')
    }
  }

  const handleValidate = () => {
    if (!csvText.trim()) { setErrorMsg('Pick a CSV file first.'); return }
    setFastPathBanner('')
    validateMut.mutate({ csv: csvText, source })
  }

  const handleReset = () => {
    setFileName('')
    setCsvText('')
    setPunchListRows(null)
    setValidateSummary(null)
    setErrorMsg('')
    setFastPathBanner('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleUnitCommitted = (unitId: string) => {
    if (!punchListRows) return
    setPunchListRows(prev => (prev || []).filter(r => r.resolvedUnitId !== unitId))
  }

  return (
    <div>
      <button onClick={onBack} className="btn btn-ghost" style={{ marginBottom: 16 }}>&larr; Back</button>

      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 12 }}>1. Pick the source platform</h2>
        <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
          Generic is the GAM-format template, ready now. Other platforms are coming. If you are migrating from one of them, pick Generic and map your columns to ours for now.
        </p>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          style={{ width: '100%', maxWidth: 360, padding: '10px 12px', borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)', color: 'var(--text-0)', fontSize: '.88rem' }}
        >
          {PLATFORM_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value} disabled={!opt.enabled}>
              {opt.label}{!opt.enabled ? ' — coming soon' : ''}
            </option>
          ))}
        </select>
      </div>

      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 12 }}>2. Get the template</h2>
        <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
          Download the GAM template, fill in your tenants and lease info, then upload it below. One row per tenant. Co-tenants on the same lease share the same property and unit number.
        </p>
        <button onClick={handleDownloadTemplate} className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Download size={14} /> Download template
        </button>
      </div>

      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 12 }}>3. Upload your filled-in CSV</h2>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
          style={{ display: 'none' }}
        />
        {!fileName ? (
          <button onClick={() => fileInputRef.current?.click()} className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Upload size={14} /> Choose CSV file
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)' }}>
              <FileText size={14} color="var(--text-2)" /> <span style={{ fontSize: '.85rem', color: 'var(--text-0)' }}>{fileName}</span>
            </div>
            <button onClick={handleReset} className="btn btn-ghost" style={{ fontSize: '.82rem' }}>Replace file</button>
            <button onClick={handleValidate} className="btn btn-primary" disabled={validateMut.isLoading} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {validateMut.isLoading ? <span className="spinner" /> : null}
              {validateMut.isLoading ? 'Validating…' : 'Validate'}
            </button>
          </div>
        )}
      </div>

      {errorMsg && (
        <div style={{ padding: 16, borderRadius: 10, background: 'rgba(220,80,80,.08)', border: '1px solid rgba(220,80,80,.3)', color: 'var(--red,#dc5050)', display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 16 }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: '.85rem' }}>{errorMsg}</div>
        </div>
      )}

      {fastPathBanner && (
        <div style={{ padding: 16, borderRadius: 10, background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.3)', color: '#22c55e', display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 16 }}>
          <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: '.85rem' }}>{fastPathBanner}</div>
        </div>
      )}

      {validateSummary && <ValidateSummary summary={validateSummary} hasPunchList={!!(punchListRows && punchListRows.length > 0)} />}

      {punchListRows && punchListRows.length > 0 && (
        <PunchList rows={punchListRows} onUnitCommitted={handleUnitCommitted} />
      )}

      {punchListRows && punchListRows.length === 0 && validateSummary && validateSummary.total > 0 && !fastPathBanner && (
        <div style={{ padding: 16, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', color: 'var(--text-2)', fontSize: '.88rem' }}>
          All units are onboarded. Nothing else to review.
        </div>
      )}
    </div>
  )
}

function ValidateSummary({ summary, hasPunchList }: { summary: { total: number; blockers: number; warnings: number; ready: number }; hasPunchList: boolean }) {
  return (
    <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
      <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 16 }}>Validation results</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <SummaryStat label="Total rows"     value={summary.total}    color="var(--text-0)" />
        <SummaryStat label="Ready"          value={summary.ready}    color="#22c55e" icon={<CheckCircle2 size={14} />} />
        <SummaryStat label="Warnings"       value={summary.warnings} color="#eab308" icon={<AlertTriangle size={14} />} />
        <SummaryStat label="Need attention" value={summary.blockers} color="#dc5050" icon={<AlertCircle size={14} />} />
      </div>
      {hasPunchList && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-0)', fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
          Units with at least one blocker are listed below. Fix the issue or promote a clean co-tenant to primary, then submit each unit.
        </div>
      )}
    </div>
  )
}

function SummaryStat({ label, value, color, icon }: { label: string; value: number; color: string; icon?: React.ReactNode }) {
  return (
    <div style={{ padding: 14, borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)' }}>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, color, display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon}{value}
      </div>
    </div>
  )
}

// ── Punch list — per-unit cards ─────────────────────────────────────────

function PunchList({ rows, onUnitCommitted }: { rows: CsvRow[]; onUnitCommitted: (unitId: string) => void }) {
  // Group by resolvedUnitId. Rows without a resolved unit get a synthetic key per row
  // (so each unmatched row appears as its own card with a clear "add property first" message).
  const groups = useMemo(() => {
    const map = new Map<string, CsvRow[]>()
    for (const r of rows) {
      const key = r.resolvedUnitId || `__unresolved_${r.rowIndex}`
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return Array.from(map.entries())
  }, [rows])

  return (
    <div>
      <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 24, marginBottom: 12 }}>
        Units that need attention ({groups.length})
      </h2>
      <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 16, lineHeight: 1.5 }}>
        Each card is one unit. Fix the highlighted fields, then submit. You can submit cards one at a time so a single bad row does not hold up the rest.
      </p>
      {groups.map(([key, groupRows]) => (
        <UnitCard
          key={key}
          initialRows={groupRows}
          onCommitted={() => { if (groupRows[0].resolvedUnitId) onUnitCommitted(groupRows[0].resolvedUnitId) }}
        />
      ))}
    </div>
  )
}

function UnitCard({ initialRows, onCommitted }: { initialRows: CsvRow[]; onCommitted: () => void }) {
  const [groupRows, setGroupRows] = useState<CsvRow[]>(initialRows)
  const [submitErr, setSubmitErr] = useState<string>('')
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [committed, setCommitted] = useState<boolean>(false)

  const primary = groupRows[0]
  const hasResolvedUnit = !!primary.resolvedUnitId

  // Tenant-row field edit. Clears that field's issues locally; backend re-validates on commit.
  // Email edits also strip resolvedExistingUserId/TenantId because the resolution becomes stale.
  const updateRowField = (rowIdx: number, field: keyof CsvRow, value: string) => {
    const issueKey = FIELD_TO_ISSUE_KEY[field as string]
    setGroupRows(prev => prev.map((r, i) => {
      if (i !== rowIdx) return r
      const issues = issueKey ? r.issues.filter(iss => iss.field !== issueKey) : r.issues
      const next: CsvRow = { ...r, [field]: value, issues } as CsvRow
      if (field === 'email' && value !== r.email) {
        delete next.resolvedExistingUserId
        delete next.resolvedExistingTenantId
      }
      return next
    }))
  }

  // Lease-level edits propagate to ALL rows in the unit. Backend uses primary group row
  // for lease values; consistency across rows keeps the data model honest.
  const updateLeaseField = (field: keyof CsvRow, value: string) => {
    const issueKey = FIELD_TO_ISSUE_KEY[field as string]
    setGroupRows(prev => prev.map(r => {
      const issues = issueKey ? r.issues.filter(iss => iss.field !== issueKey) : r.issues
      return { ...r, [field]: value, issues } as CsvRow
    }))
  }

  const promoteToPrimary = (rowIdx: number) => {
    if (rowIdx === 0) return
    setGroupRows(prev => {
      const next = [...prev]
      const [picked] = next.splice(rowIdx, 1)
      next.unshift(picked)
      return next
    })
  }

  const removeRow = (rowIdx: number) => {
    setGroupRows(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== rowIdx))
  }

  const handleSubmit = async () => {
    setSubmitErr('')
    setSubmitting(true)
    try {
      await apiPost<CommitResponse>('/landlords/me/onboard-tenants-csv/commit', { rows: groupRows })
      setCommitted(true)
      // Brief pause so the green confirmation flashes before the parent unmounts the card.
      setTimeout(() => onCommitted(), 600)
    } catch (e: any) {
      setSubmitErr(e?.response?.data?.message || 'Submission failed. Check the highlighted fields.')
    } finally {
      setSubmitting(false)
    }
  }

  if (committed) {
    return (
      <div style={{ padding: 16, borderRadius: 10, background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.3)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <CheckCircle2 size={16} color="#22c55e" />
        <div style={{ fontSize: '.88rem', color: '#22c55e' }}>
          Onboarded {primary.propertyName} — Unit {primary.unitNumber}.
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 20, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-0)' }}>
          {primary.propertyName || '(unmatched property)'} — Unit {primary.unitNumber || '(unmatched)'}
        </div>
        {!hasResolvedUnit && (
          <div style={{ fontSize: '.82rem', color: '#dc5050', marginTop: 4 }}>
            This property/unit pair was not found in your portfolio. Add the property and unit first, then re-upload the CSV.
          </div>
        )}
      </div>

      <div style={{ padding: 14, borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>Lease</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          <Field label="Start date" type="date" value={primary.leaseStart} issues={primary.issues} field="lease_start"
                 onChange={v => updateLeaseField('leaseStart', v)} />
          <Field label="End date (blank = month-to-month)" type="date" value={primary.leaseEnd} issues={primary.issues} field="lease_end"
                 onChange={v => updateLeaseField('leaseEnd', v)} />
          <Field label="Monthly rent" type="number" value={primary.monthlyRent} issues={primary.issues} field="monthly_rent"
                 onChange={v => updateLeaseField('monthlyRent', v)} />
          <Field label="Security deposit" type="number" value={primary.securityDeposit} issues={primary.issues} field="security_deposit"
                 onChange={v => updateLeaseField('securityDeposit', v)} />
          <Field label="Late fee amount" type="number" value={primary.lateFeeAmount} issues={primary.issues} field="late_fee_amount"
                 onChange={v => updateLeaseField('lateFeeAmount', v)} />
          <Field label="Late fee grace days" type="number" value={primary.lateFeeGraceDays} issues={primary.issues} field="late_fee_grace_days"
                 onChange={v => updateLeaseField('lateFeeGraceDays', v)} />
          <SelectField label="Auto-renew" value={primary.autoRenew} issues={primary.issues} field="auto_renew"
                       onChange={v => updateLeaseField('autoRenew', v)}
                       options={[{ value: '', label: '— select —' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
          {String(primary.autoRenew).toLowerCase() === 'yes' && (
            <SelectField label="Auto-renew mode" value={primary.autoRenewMode} issues={primary.issues} field="auto_renew_mode"
                         onChange={v => updateLeaseField('autoRenewMode', v)}
                         options={[
                           { value: '', label: '— select —' },
                           { value: 'extend_same_term', label: 'Extend same term' },
                           { value: 'convert_to_month_to_month', label: 'Convert to month-to-month' },
                         ]} />
          )}
          <Field label="Notice days required" type="number" value={primary.noticeDaysRequired} issues={primary.issues} field="notice_days_required"
                 onChange={v => updateLeaseField('noticeDaysRequired', v)} />
        </div>
      </div>

      <div style={{ padding: 14, borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
          Tenants ({groupRows.length})
        </div>
        {groupRows.map((r, idx) => (
          <div key={r.rowIndex} style={{ padding: 12, borderRadius: 8, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: idx === groupRows.length - 1 ? 0 : 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: '.82rem', fontWeight: 700, color: idx === 0 ? 'var(--gold,#c4a14a)' : 'var(--text-2)' }}>
                {idx === 0 ? 'PRIMARY' : 'CO-TENANT'}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {idx !== 0 && (
                  <button onClick={() => promoteToPrimary(idx)} className="btn btn-ghost" style={{ fontSize: '.78rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <ArrowUp size={12} /> Make primary
                  </button>
                )}
                {groupRows.length > 1 && (
                  <button onClick={() => removeRow(idx)} className="btn btn-ghost" style={{ fontSize: '.78rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <X size={12} /> Remove
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
              <Field label="First name" value={r.firstName} issues={r.issues} field="first_name"
                     onChange={v => updateRowField(idx, 'firstName', v)} />
              <Field label="Last name" value={r.lastName} issues={r.issues} field="last_name"
                     onChange={v => updateRowField(idx, 'lastName', v)} />
              <Field label="Email" type="email" value={r.email} issues={r.issues} field="email"
                     onChange={v => updateRowField(idx, 'email', v)} />
              <Field label="Phone" value={r.phone} issues={r.issues} field="phone"
                     onChange={v => updateRowField(idx, 'phone', v)} />
            </div>
          </div>
        ))}
      </div>

      {submitErr && (
        <div style={{ padding: 12, borderRadius: 8, background: 'rgba(220,80,80,.08)', border: '1px solid rgba(220,80,80,.3)', color: 'var(--red,#dc5050)', fontSize: '.82rem', marginBottom: 12 }}>
          {submitErr}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={handleSubmit} disabled={submitting || !hasResolvedUnit} className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {submitting ? <span className="spinner" /> : null}
          {submitting ? 'Onboarding…' : 'Onboard this unit'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, issues, field, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  issues: CsvIssue[]; field: string; type?: string
}) {
  const fieldIssues = issues.filter(i => i.field === field)
  const hasBlock = fieldIssues.some(i => i.severity === 'block')
  const hasWarn = fieldIssues.some(i => i.severity === 'warn') && !hasBlock
  const borderColor = hasBlock ? '#dc5050' : hasWarn ? '#eab308' : 'var(--border-0)'
  return (
    <div>
      <label style={{ display: 'block', fontSize: '.75rem', color: 'var(--text-2)', marginBottom: 4 }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, background: 'var(--bg-0)', border: `1px solid ${borderColor}`, color: 'var(--text-0)', fontSize: '.85rem' }}
      />
      {fieldIssues.length > 0 && (
        <div style={{ fontSize: '.72rem', color: hasBlock ? '#dc5050' : '#eab308', marginTop: 3, lineHeight: 1.4 }}>
          {fieldIssues.map((i, k) => <div key={k}>{i.message}</div>)}
        </div>
      )}
    </div>
  )
}

function SelectField({ label, value, onChange, issues, field, options }: {
  label: string; value: string; onChange: (v: string) => void;
  issues: CsvIssue[]; field: string; options: { value: string; label: string }[]
}) {
  const fieldIssues = issues.filter(i => i.field === field)
  const hasBlock = fieldIssues.some(i => i.severity === 'block')
  const hasWarn = fieldIssues.some(i => i.severity === 'warn') && !hasBlock
  const borderColor = hasBlock ? '#dc5050' : hasWarn ? '#eab308' : 'var(--border-0)'
  return (
    <div>
      <label style={{ display: 'block', fontSize: '.75rem', color: 'var(--text-2)', marginBottom: 4 }}>{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, background: 'var(--bg-0)', border: `1px solid ${borderColor}`, color: 'var(--text-0)', fontSize: '.85rem' }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {fieldIssues.length > 0 && (
        <div style={{ fontSize: '.72rem', color: hasBlock ? '#dc5050' : '#eab308', marginTop: 3, lineHeight: 1.4 }}>
          {fieldIssues.map((i, k) => <div key={k}>{i.message}</div>)}
        </div>
      )}
    </div>
  )
}
