import { useState, useRef, useMemo } from 'react'
import { useMutation, useQuery } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { Upload, Download, FileText, AlertCircle, CheckCircle2, AlertTriangle, ArrowUp, X, Inbox } from 'lucide-react'
import { api, apiPost, apiGet } from '../lib/api'
import { AUTO_RENEW_MODES, AUTO_RENEW_MODE_LABEL } from '@gam/shared'

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
  outstandingBalance: string
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
  /** S296: true when this platform + import_type slot has not yet
   *  been marked verified by super admin. Triggers the review
   *  banner. Replaces S295's firstFive flag. */
  escalateToSuperAdmin?: boolean
  mappingStatus?: 'unverified' | 'verified'
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
  outstandingBalance: 'outstanding_balance',
}

const PLATFORM_OPTIONS = [
  { value: 'generic',     label: 'Generic (GAM template)', enabled: true },
  { value: 'buildium',    label: 'Buildium',               enabled: true },
  { value: 'appfolio',    label: 'AppFolio',               enabled: true },
  { value: 'doorloop',    label: 'DoorLoop',               enabled: true },
  { value: 'yardi',       label: 'Yardi',                  enabled: true },
  { value: 'rentmanager', label: 'RentManager',            enabled: true },
  { value: 'propertyware',label: 'Propertyware',           enabled: true },
  { value: 'rentec',      label: 'Rentec Direct',          enabled: true },
  { value: 'tenantcloud', label: 'TenantCloud',            enabled: true },
]

type Mode = 'choose' | 'bulk' | 'single'

export function TenantOnboardingPage() {
  const [mode, setMode] = useState<Mode>('choose')
  const navigate = useNavigate()

  // Static pending count for the third mode card. staleTime 30s — mode picker
  // is a navigation surface, not a working surface. Click into the pool for
  // live state. Defensive against wrapped/unwrapped API response shapes.
  const { data: pendingCount = 0 } = useQuery(
    'pending-tenants-count',
    () => apiGet('/landlords/me/pending-tenants').then((r: any) => {
      const list = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : [])
      return list.length
    }),
    { staleTime: 30_000, refetchOnWindowFocus: false }
  )

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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
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

          <button
            onClick={() => navigate('/tenant-onboarding/pending')}
            style={{ textAlign: 'left', padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', cursor: 'pointer', position: 'relative' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Inbox size={16} style={{ color: 'var(--text-2)' }} />
                <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)' }}>Pending Pool</div>
              </div>
              {pendingCount > 0 && (
                <span className="badge badge-amber" style={{ fontSize: '.72rem' }}>
                  {pendingCount} pending
                </span>
              )}
            </div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              Tenants waiting on a lease document. Upload PDFs to complete onboarding.
            </div>
          </button>
        </div>
      )}

      {mode === 'bulk' && <BulkCsvMode onBack={() => setMode('choose')} />}

      {mode === 'single' && (
        <SingleTenantMode
          onBack={() => setMode('choose')}
          onComplete={() => navigate('/tenant-onboarding/pending')}
        />
      )}
    </div>
  )
}

// Identity field set — these blockers mean we can't safely create a user
// record at all. Rows with any identity blocker stay in the punch list for
// inline correction. Lease-only blockers (rent, dates, unit) route to limbo.
const IDENTITY_FIELDS = new Set(['first_name', 'last_name', 'email', 'phone'])

// Split dirty rows into limbo-routeable vs punch-list. A row is limbo-routeable
// if it has at least one block-severity issue AND every block-severity issue
// is on a non-identity field. Rows with mixed (identity + lease) blockers, or
// pure identity blockers, stay in punch list.
//
// Backend re-validates identity server-side. Frontend classification is a
// hint; bad data here gets caught and returned as a per-row error.
function splitDirtyRows(rows: CsvRow[]): { limboRows: CsvRow[]; punchListRows: CsvRow[] } {
  const limboRows: CsvRow[] = []
  const punchListRows: CsvRow[] = []
  for (const r of rows) {
    const blockers = r.issues.filter(i => i.severity === 'block')
    if (blockers.length === 0) {
      // Defensive — splitFastPath should have caught this, but if a row with
      // no blockers landed here (e.g. cross-landlord warn-only), keep it in
      // punch list rather than silently routing.
      punchListRows.push(r)
      continue
    }
    const hasIdentityBlocker = blockers.some(b => b.field && IDENTITY_FIELDS.has(b.field))
    if (hasIdentityBlocker) {
      punchListRows.push(r)
    } else {
      limboRows.push(r)
    }
  }
  return { limboRows, punchListRows }
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

function SingleTenantMode({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '' })
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ intentId: string | null; name: string } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const set = (k: keyof typeof form, v: string) => setForm(prev => ({ ...prev, [k]: v }))

  const submitMut = useMutation(
    () => apiPost<any>('/landlords/me/onboard-tenant-pending', form),
    {
      onSuccess: (res: any) => {
        // Codebase convention: handlers return { success, data: { ... } }.
        // Defensive against shape drift — fall back to navigate-to-pool if intentId missing.
        const intentId = res?.data?.intentId || res?.data?.intentId || null
        setSuccess({
          intentId,
          name: `${form.firstName} ${form.lastName}`.trim() || form.email,
        })
        setError(null)
      },
      onError: (e: any) => {
        // Backend 409 messages surface here directly:
        //  - "Tenant has an active lease with another landlord. Cannot onboard to your portfolio."
        //  - "Tenant already has an active lease with you."
        //  - "Pending intent already exists for this email."
        setError(e?.response?.data?.message || 'Could not add tenant.')
      },
    }
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const trimmed = {
      firstName: form.firstName.trim(),
      lastName:  form.lastName.trim(),
      email:     form.email.trim(),
      phone:     form.phone.trim(),
    }
    if (!trimmed.firstName || !trimmed.lastName || !trimmed.email || !trimmed.phone) {
      setError('All fields are required.')
      return
    }
    setForm(trimmed)
    submitMut.mutate()
  }

  const handleAddAnother = () => {
    setForm({ firstName: '', lastName: '', email: '', phone: '' })
    setSuccess(null)
    setError(null)
    setUploadError(null)
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !success?.intentId) return
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setUploadError('File must be a PDF.')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setUploadError('File exceeds the 20 MB limit.')
      return
    }
    setUploading(true)
    setUploadError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(
        `/landlords/me/pending-tenants/${success.intentId}/document`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      )
      onComplete()
    } catch (err: any) {
      setUploadError(err?.response?.data?.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  // Form state — collecting tenant info.
  if (!success) {
    return (
      <div>
        <button onClick={onBack} className="btn btn-ghost" style={{ marginBottom: 16 }}>&larr; Back</button>
        <form onSubmit={handleSubmit} style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', maxWidth: 560 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-0)', margin: 0, marginBottom: 6 }}>
            Add One Tenant
          </h2>
          <p style={{ fontSize: '.84rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 20, lineHeight: 1.5 }}>
            Type the tenant's contact info. They land in your pending pool until you upload
            their lease PDF — the parser fills in unit and lease terms automatically.
          </p>

          {error && (
            <div style={{
              padding: 10, marginBottom: 16, background: 'var(--bg-2)',
              borderLeft: '3px solid #dc2626', borderRadius: 6,
              fontSize: '.84rem', color: 'var(--text-1)',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <AlertCircle size={14} style={{ color: '#dc2626', flexShrink: 0, marginTop: 2 }} />
              <span>{error}</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>First name</label>
              <input className="input" placeholder="Jane" value={form.firstName} onChange={e => set('firstName', e.target.value)} autoFocus style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>Last name</label>
              <input className="input" placeholder="Smith" value={form.lastName} onChange={e => set('lastName', e.target.value)} style={{ width: '100%' }} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>Email</label>
            <input className="input" type="email" placeholder="jane@example.com" value={form.email} onChange={e => set('email', e.target.value)} style={{ width: '100%' }} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>Phone</label>
            <input className="input" type="tel" placeholder="(555) 000-0000" value={form.phone} onChange={e => set('phone', e.target.value)} style={{ width: '100%' }} />
          </div>

          <button type="submit" disabled={submitMut.isLoading} className="btn btn-primary" style={{ width: '100%' }}>
            {submitMut.isLoading ? 'Adding...' : 'Add tenant to pending pool'}
          </button>
        </form>
      </div>
    )
  }

  // Success state — tenant added, optional inline PDF upload.
  return (
    <div>
      <button onClick={onBack} className="btn btn-ghost" style={{ marginBottom: 16 }}>&larr; Back</button>
      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <CheckCircle2 size={20} style={{ color: '#16a34a' }} />
          <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', margin: 0 }}>
            {success.name} added to pending pool
          </h2>
        </div>
        <p style={{ fontSize: '.84rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 20, lineHeight: 1.5 }}>
          Upload the lease PDF now and the parser will read the unit and lease terms.
          You can also do this later from the Pending Pool.
        </p>

        {uploadError && (
          <div style={{
            padding: 10, marginBottom: 16, background: 'var(--bg-2)',
            borderLeft: '3px solid #dc2626', borderRadius: 6,
            fontSize: '.84rem', color: 'var(--text-1)',
            display: 'flex', alignItems: 'flex-start', gap: 8,
          }}>
            <AlertCircle size={14} style={{ color: '#dc2626', flexShrink: 0, marginTop: 2 }} />
            <span>{uploadError}</span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {success.intentId ? (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="btn btn-primary"
              style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              <Upload size={14} />
              {uploading ? 'Uploading...' : 'Upload lease PDF'}
            </button>
          ) : (
            <button onClick={onComplete} className="btn btn-primary" style={{ width: '100%' }}>
              Go to Pending Pool to upload
            </button>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAddAnother} className="btn btn-ghost" style={{ flex: 1 }}>
              Add another
            </button>
            <button onClick={onComplete} className="btn btn-ghost" style={{ flex: 1 }}>
              View pending pool
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function BulkCsvMode({ onBack }: { onBack: () => void }) {
  const [source, setSource] = useState<string>('generic')
  const [fileName, setFileName] = useState<string>('')
  const [csvText, setCsvText] = useState<string>('')
  const [punchListRows, setPunchListRows] = useState<CsvRow[] | null>(null)
  const [validateSummary, setValidateSummary] = useState<{ total: number; blockers: number; warnings: number; ready: number } | null>(null)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [fastPathBanner, setFastPathBanner] = useState<string>('')
  const [reviewBanner, setReviewBanner] = useState<{ platform: string } | null>(null)
  // S297: free-text claim required on generic uploads.
  const [claimedPlatformName, setClaimedPlatformName] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Limbo state — rows missing only lease data routed to pending pool.
  const [limboBanner, setLimboBanner] = useState<string>('')
  const [limboErrors, setLimboErrors] = useState<Array<{ rowIndex: number; email: string; message: string }>>([])

  // S297: client mirror of normalizeClaimName for soft-warning check.
  const normalizeClaim = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const claimMatchesExisting = useMemo(() => {
    if (!claimedPlatformName.trim()) return null
    const n = normalizeClaim(claimedPlatformName)
    if (!n) return null
    return PLATFORM_OPTIONS.find(p =>
      p.value !== 'generic' && p.enabled && (
        normalizeClaim(p.value) === n || normalizeClaim(p.label) === n
      )
    ) || null
  }, [claimedPlatformName])

  const validateMut = useMutation(
    (body: { csv: string; source: string; claimedPlatformName?: string }) => apiPost<ValidateResponse>('/landlords/me/onboard-tenants-csv/validate', body),
    {
      onSuccess: async (res: any) => {
        const data: ValidateResponse = res.data
        setErrorMsg('')
        setValidateSummary(data.summary)
        setLimboBanner('')
        setLimboErrors([])

        const { fastPathRows, dirtyRows } = splitFastPath(data.rows)
        const { limboRows, punchListRows: identityBlockerRows } = splitDirtyRows(dirtyRows)

        // Fast-path: clean unit groups commit straight through. Existing flow.
        let fastPathFailed = false
        if (fastPathRows.length > 0) {
          try {
            const commitRes: any = await apiPost<CommitResponse>('/landlords/me/onboard-tenants-csv/commit', {
              rows: fastPathRows, source,
              ...(source === 'generic' ? { claimedPlatformName: claimedPlatformName.trim() } : {}),
            })
            const c: CommitResponse = commitRes.data
            const tenantWord = c.committed === 1 ? 'tenant' : 'tenants'
            const unitWord = c.leases === 1 ? 'unit' : 'units'
            setFastPathBanner(`${c.committed} ${tenantWord} onboarded across ${c.leases} ${unitWord}. Activation emails sent.`)
            if (c.escalateToSuperAdmin) {
              const label = PLATFORM_OPTIONS.find(p => p.value === source)?.label || source
              setReviewBanner({ platform: label })
            } else {
              setReviewBanner(null)
            }
          } catch (e: any) {
            // Fast-path failure: roll fast-path rows into punch list. Limbo
            // dispatch still attempted independently below — separate failures.
            setErrorMsg(e?.response?.data?.message || 'Some rows could not be auto-onboarded. Review below.')
            fastPathFailed = true
          }
        }

        // Limbo: rows with only lease-only blockers route to pending pool.
        // Independent of fast-path — runs even if fast-path failed.
        if (limboRows.length > 0) {
          try {
            const limboRes: any = await apiPost<{ created: number; skipped: number; results: Array<{ rowIndex: number; email: string; status: string; intentId?: string; message?: string }> }>(
              '/landlords/me/onboard-tenants-csv/commit-pending',
              { rows: limboRows }
            )
            const l = limboRes.data
            if (l.created > 0) {
              const tenantWord = l.created === 1 ? 'tenant' : 'tenants'
              setLimboBanner(`${l.created} ${tenantWord} routed to pending pool. Upload their lease PDFs to complete onboarding.`)
            }
            const errs = (l.results || [])
              .filter((r: any) => r.status === 'error')
              .map((r: any) => ({ rowIndex: r.rowIndex, email: r.email, message: r.message || 'Row failed' }))
            if (errs.length > 0) {
              setLimboErrors(errs)
              const erroredIndexes = new Set(errs.map((e: { rowIndex: number }) => e.rowIndex))
              const erroredRows = limboRows.filter(r => erroredIndexes.has(r.rowIndex))
              identityBlockerRows.push(...erroredRows)
            }
          } catch (e: any) {
            // Network or 500-level failure on the whole batch. Roll limbo
            // rows back into punch list with banner-level error.
            setErrorMsg(e?.response?.data?.message || 'Could not route tenants to pending pool. Review below.')
            identityBlockerRows.push(...limboRows)
          }
        }

        // Settle the punch list once. If fast-path failed, include those too.
        if (fastPathFailed) {
          setPunchListRows([...fastPathRows, ...identityBlockerRows])
        } else {
          setPunchListRows(identityBlockerRows)
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
    setLimboBanner('')
    setLimboErrors([])
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
      const res = await fetch(`${apiUrl}/api/landlords/me/onboard-tenants-csv/template?source=${encodeURIComponent(source)}`, {
        headers: { Authorization: 'Bearer ' + token },
      })
      if (!res.ok) { setErrorMsg('Could not download the template.'); return }
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = source === 'generic'
        ? 'gam-tenant-onboarding-template.csv'
        : `gam-tenant-onboarding-template-${source}.csv`
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
    if (source === 'generic' && !claimedPlatformName.trim()) {
      setErrorMsg('Enter the platform name your CSV came from before validating.')
      return
    }
    setFastPathBanner('')
    setLimboBanner('')
    setLimboErrors([])
    validateMut.mutate({
      csv: csvText, source,
      ...(source === 'generic' ? { claimedPlatformName: claimedPlatformName.trim() } : {}),
    })
  }

  const handleReset = () => {
    setFileName('')
    setCsvText('')
    setPunchListRows(null)
    setValidateSummary(null)
    setErrorMsg('')
    setFastPathBanner('')
    setLimboBanner('')
    setLimboErrors([])
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
          GAM recognizes the standard export column names from Buildium, AppFolio, DoorLoop,
          Yardi, RentManager, Propertyware, Rentec Direct, and TenantCloud. Pick yours and we'll
          auto-map the columns; the preview step lets you correct anything that didn't land cleanly
          before anything is committed. Pick Generic if you're hand-filling the GAM template instead.
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

        {source === 'generic' && (
          <div style={{ marginTop: 16 }}>
            <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-1)', marginBottom: 6, fontWeight: 600 }}>
              What platform is this CSV from? <span style={{ color: 'var(--gold)' }}>*</span>
            </label>
            <input
              type="text"
              value={claimedPlatformName}
              onChange={e => setClaimedPlatformName(e.target.value)}
              placeholder="e.g. Hemlane, SimplifyEm, Rentmoji..."
              style={{ width: '100%', maxWidth: 360, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)', color: 'var(--text-0)', fontSize: '.86rem' }}
            />
            <p style={{ fontSize: '.74rem', color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 }}>
              We track which platforms our customers migrate from so we can build dedicated importers when enough demand shows up.
            </p>
            {claimMatchesExisting && (
              <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 7, background: 'var(--bg-2)', borderLeft: '3px solid var(--gold)', fontSize: '.78rem', color: 'var(--text-1)' }}>
                We have a dedicated <strong>{claimMatchesExisting.label}</strong> importer — switch to <em>{claimMatchesExisting.label}</em> in the dropdown above for better column mapping.
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 12 }}>
          2. {source === 'generic' ? 'Get the template' : 'Export from your platform'}
        </h2>
        {source === 'generic' ? (
          <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
            Download the GAM template, fill in your tenants and lease info, then upload it below. One row per tenant. Co-tenants on the same lease share the same property and unit number.
          </p>
        ) : (
          <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
            {source === 'buildium' && 'Export from Buildium: Reports > Tenant List > Export to CSV. We map the tenant + active-lease columns automatically.'}
            {source === 'appfolio' && 'Export from AppFolio: Reports > Tenant Directory > Export to CSV. If your export uses a combined "Tenant" column instead of First/Last, split it in your spreadsheet before uploading.'}
            {source === 'doorloop' && 'Export from DoorLoop: Tenants > Export to CSV. We map the tenant + primary-lease columns automatically.'}
            {source === 'yardi' && 'Export from Yardi (Voyager or Breeze): Resident Roster or Rent Roll. If your export uses a combined "Resident Name" column, split it into First/Last before uploading.'}
            {source === 'rentmanager' && 'Export from RentManager: Reports > Tenant List > CSV.'}
            {source === 'propertyware' && 'Export from Propertyware: Reports > Tenant Roster > CSV.'}
            {source === 'rentec' && 'Export from Rentec Direct: Tenants > Export. If your export combines name into "Tenant Name", split it before uploading.'}
            {source === 'tenantcloud' && 'Export from TenantCloud: Tenants > Export to CSV.'}
            {' '}Upload the CSV below — GAM recognizes the platform's standard column names. The download button gives you the column reference if you need it.
          </p>
        )}
        <button onClick={handleDownloadTemplate} className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Download size={14} /> {source === 'generic' ? 'Download template' : 'Download column reference'}
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

      {reviewBanner && (
        <div style={{
          padding: 14, marginBottom: 16, background: 'var(--bg-2)',
          borderLeft: '3px solid var(--gold)', borderRadius: 6,
          fontSize: '.9rem', color: 'var(--text-0)',
        }}>
          <strong>We're reviewing your {reviewBanner.platform} migration for accuracy.</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>
            Our team checks the column mapping on every new {reviewBanner.platform} import to make sure your data landed cleanly. If anything looks off we'll reach out. No action needed from you.
          </div>
        </div>
      )}

      {limboBanner && (
        <div style={{ padding: 16, borderRadius: 10, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.3)', color: '#f59e0b', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <Inbox size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: '.85rem', flex: 1, color: 'var(--text-1)' }}>
              {limboBanner}{' '}
              <span
                onClick={() => window.location.assign('/tenant-onboarding/pending')}
                style={{ color: '#f59e0b', textDecoration: 'underline', cursor: 'pointer' }}
              >
                Open pending pool
              </span>
            </div>
          </div>
          {limboErrors.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(245,158,11,.2)' }}>
              <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 6 }}>
                {limboErrors.length} {limboErrors.length === 1 ? 'row' : 'rows'} could not be routed:
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
                {limboErrors.map((er, i) => (
                  <li key={i}>
                    Row {er.rowIndex + 1} ({er.email}): {er.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {validateSummary && <ValidateSummary summary={validateSummary} hasPunchList={!!(punchListRows && punchListRows.length > 0)} />}

      {punchListRows && punchListRows.length > 0 && (
        <PunchList rows={punchListRows} source={source} claimedPlatformName={claimedPlatformName} onUnitCommitted={handleUnitCommitted} />
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

function PunchList({ rows, source, claimedPlatformName, onUnitCommitted }: { rows: CsvRow[]; source: string; claimedPlatformName: string; onUnitCommitted: (unitId: string) => void }) {
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
          source={source}
          claimedPlatformName={claimedPlatformName}
          onCommitted={() => { if (groupRows[0].resolvedUnitId) onUnitCommitted(groupRows[0].resolvedUnitId) }}
        />
      ))}
    </div>
  )
}

function UnitCard({ initialRows, source, claimedPlatformName, onCommitted }: { initialRows: CsvRow[]; source: string; claimedPlatformName: string; onCommitted: () => void }) {
  const [groupRows, setGroupRows] = useState<CsvRow[]>(initialRows)
  const [submitErr, setSubmitErr] = useState<string>('')
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [committed, setCommitted] = useState<boolean>(false)
  const [routedTo, setRoutedTo] = useState<'commit' | 'limbo' | null>(null)

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
      // S177: re-classify groupRows at submit time. Pre-S177 the punch-list
      // resubmit always hit /commit, which rejects on any remaining lease
      // blocker — so a row with an identity blocker fix that still has a
      // lease blocker would error out and the landlord had to hand-route it
      // to the limbo flow. Mirror the initial-CSV split-dispatch logic
      // here so partially-fixed rows route automatically.
      const rowsWithIdentityBlocker = groupRows.filter(r =>
        r.issues.some(i => i.severity === 'block' && i.field && IDENTITY_FIELDS.has(i.field))
      )
      if (rowsWithIdentityBlocker.length > 0) {
        const names = rowsWithIdentityBlocker
          .map(r => `${r.firstName || ''} ${r.lastName || ''}`.trim() || r.email || `row ${r.rowIndex}`)
          .join(', ')
        setSubmitErr(`These tenants still need fixes: ${names}. Resolve the highlighted identity fields, then submit.`)
        setSubmitting(false)
        return
      }
      const groupHasLeaseBlocker = groupRows.some(r =>
        r.issues.some(i => i.severity === 'block' && (!i.field || !IDENTITY_FIELDS.has(i.field)))
      )
      if (groupHasLeaseBlocker) {
        // All identity clean, but lease info is still incomplete — dispatch
        // the whole group to limbo. Each row becomes a user + tenant +
        // pending_tenant_intent on the backend; lease will be built later
        // from a parsed PDF or manual entry.
        await apiPost('/landlords/me/onboard-tenants-csv/commit-pending', { rows: groupRows })
        setRoutedTo('limbo')
      } else {
        await apiPost<CommitResponse>('/landlords/me/onboard-tenants-csv/commit', {
          rows: groupRows, source,
          ...(source === 'generic' ? { claimedPlatformName: claimedPlatformName.trim() } : {}),
        })
        setRoutedTo('commit')
      }
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
          {routedTo === 'limbo'
            ? `Routed to pending pool — ${primary.propertyName} Unit ${primary.unitNumber}. Upload the lease PDF on the Pending Tenants page to finish onboarding.`
            : `Onboarded ${primary.propertyName} — Unit ${primary.unitNumber}.`}
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
                           ...AUTO_RENEW_MODES.map(m => ({ value: m, label: AUTO_RENEW_MODE_LABEL[m] })),
                         ]} />
          )}
          <Field label="Notice days required" type="number" value={primary.noticeDaysRequired} issues={primary.issues} field="notice_days_required"
                 onChange={v => updateLeaseField('noticeDaysRequired', v)} />
          <Field label="Opening balance (carry-over AR)" type="number" value={primary.outstandingBalance} issues={primary.issues} field="outstanding_balance"
                 onChange={v => updateLeaseField('outstandingBalance', v)} />
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
