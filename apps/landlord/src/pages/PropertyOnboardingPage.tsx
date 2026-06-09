import { useState, useRef, useMemo } from 'react'
import { useMutation } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { Upload, Download, FileText, AlertCircle, CheckCircle2, AlertTriangle, X } from 'lucide-react'
import { api, apiPost } from '../lib/api'

type CsvIssue = { severity: 'block' | 'warn'; field?: string; message: string }
type PropertyCsvRow = {
  rowIndex: number
  propertyName: string
  street1: string
  street2: string
  city: string
  state: string
  zip: string
  timezone: string
  propertyType: string
  unitNumber: string
  bedrooms: string
  bathrooms: string
  sqft: string
  unitType: string
  rentAmount: string
  securityDeposit: string
  resolvedPropertyId?: string
  resolvedUnitId?: string
  issues: CsvIssue[]
}
type ValidateResponse = {
  rows: PropertyCsvRow[]
  summary: { total: number; blockers: number; warnings: number; ready: number; newProperties: number; newUnits: number }
}
type CommitResponse = {
  propertiesCreated: number
  unitsCreated: number
  unitsSkipped: number
  properties: { id: string; name: string }[]
  units: { id: string; unitNumber: string; propertyId: string }[]
  /** S296: true when this platform + import_type slot has not yet
   *  been marked verified by super admin. Triggers the review
   *  banner. Replaces S295's firstFive flag. */
  escalateToSuperAdmin?: boolean
  mappingStatus?: 'unverified' | 'verified'
}

const FIELD_TO_ISSUE_KEY: Record<string, string> = {
  propertyName:    'property_name',
  street1:         'street1',
  street2:         'street2',
  city:            'city',
  state:           'state',
  zip:             'zip',
  timezone:        'timezone',
  propertyType:    'property_type',
  unitNumber:      'unit_number',
  bedrooms:        'bedrooms',
  bathrooms:       'bathrooms',
  sqft:            'sqft',
  unitType:        'unit_type',
  rentAmount:      'rent_amount',
  securityDeposit: 'security_deposit',
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

export function PropertyOnboardingPage() {
  const navigate = useNavigate()
  const [source, setSource] = useState<string>('generic')
  const [fileName, setFileName] = useState<string>('')
  const [csvText, setCsvText] = useState<string>('')
  const [punchListRows, setPunchListRows] = useState<PropertyCsvRow[] | null>(null)
  const [summary, setSummary] = useState<ValidateResponse['summary'] | null>(null)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [successBanner, setSuccessBanner] = useState<string>('')
  const [reviewBanner, setReviewBanner] = useState<{ platform: string } | null>(null)
  // S297: free-text claim required on generic uploads.
  const [claimedPlatformName, setClaimedPlatformName] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // S297: lightweight client-side mirror of services/csvImportAttempts.ts
  // normalizeClaimName(). Used for the "we have a dedicated importer"
  // soft-warning check.
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
    (body: { csv: string; source: string; claimedPlatformName?: string }) =>
      apiPost<ValidateResponse>('/landlords/me/onboard-properties-csv/validate', body),
    {
      onSuccess: (res: any) => {
        const data: ValidateResponse = res.data
        setErrorMsg('')
        setSummary(data.summary)
        setPunchListRows(data.rows)
      },
      onError: (err: any) => {
        setErrorMsg(err?.response?.data?.message || 'Validation failed. Check the CSV format and try again.')
        setPunchListRows(null)
        setSummary(null)
      },
    }
  )

  const commitMut = useMutation(
    (rows: PropertyCsvRow[]) =>
      apiPost<CommitResponse>('/landlords/me/onboard-properties-csv/commit', {
        rows, source,
        ...(source === 'generic' ? { claimedPlatformName: claimedPlatformName.trim() } : {}),
      }),
    {
      onSuccess: (res: any) => {
        const d: CommitResponse = res.data
        const propWord = d.propertiesCreated === 1 ? 'property' : 'properties'
        const unitWord = d.unitsCreated === 1 ? 'unit' : 'units'
        const skipPart = d.unitsSkipped > 0 ? ` ${d.unitsSkipped} skipped (already existed).` : ''
        setSuccessBanner(`${d.propertiesCreated} ${propWord} and ${d.unitsCreated} ${unitWord} created.${skipPart}`)
        if (d.escalateToSuperAdmin) {
          const label = PLATFORM_OPTIONS.find(p => p.value === source)?.label || source
          setReviewBanner({ platform: label })
        } else {
          setReviewBanner(null)
        }
        setPunchListRows(null)
        setSummary(null)
        setFileName('')
        setCsvText('')
        if (fileInputRef.current) fileInputRef.current.value = ''
      },
      onError: (err: any) => {
        setErrorMsg(err?.response?.data?.message || 'Commit failed. Review the issues below.')
      },
    }
  )

  const handleFile = (file: File) => {
    setFileName(file.name)
    setErrorMsg('')
    setPunchListRows(null)
    setSummary(null)
    setSuccessBanner('')
    const reader = new FileReader()
    reader.onload = () => setCsvText(reader.result as string)
    reader.readAsText(file)
  }

  const handleValidate = () => {
    if (!csvText) {
      setErrorMsg('Pick a CSV file first.')
      return
    }
    validateMut.mutate({
      csv: csvText, source,
      ...(source === 'generic' ? { claimedPlatformName: claimedPlatformName.trim() } : {}),
    })
  }

  const handleDownloadTemplate = async () => {
    try {
      const res = await api.get(`/landlords/me/onboard-properties-csv/template?source=${source}`, { responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }))
      const a = document.createElement('a')
      a.href = url
      a.download = source === 'generic' ? 'gam-property-template.csv' : `gam-property-template-${source}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setErrorMsg(e?.response?.data?.message || 'Could not download template.')
    }
  }

  const handleReset = () => {
    setFileName('')
    setCsvText('')
    setPunchListRows(null)
    setSummary(null)
    setErrorMsg('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const updateRow = (rowIndex: number, key: keyof PropertyCsvRow, value: string) => {
    setPunchListRows(prev => prev?.map(r =>
      r.rowIndex === rowIndex
        ? {
            ...r,
            [key]: value,
            // Clear blocker for this field on edit. Server will re-validate
            // on commit.
            issues: r.issues.filter(i =>
              !(i.severity === 'block' && i.field === FIELD_TO_ISSUE_KEY[key as string])
            ),
          }
        : r
    ) || null)
  }

  const handleCommit = () => {
    if (!punchListRows) return
    if (source === 'generic' && !claimedPlatformName.trim()) {
      setErrorMsg('Enter the platform name your CSV came from before committing.')
      return
    }
    const stillBlocked = punchListRows.filter(r => r.issues.some(i => i.severity === 'block'))
    if (stillBlocked.length > 0) {
      setErrorMsg(`${stillBlocked.length} row(s) still have blockers. Fix them or remove the rows before committing.`)
      return
    }
    commitMut.mutate(punchListRows)
  }

  return (
    <div style={{ padding: 24, maxWidth: 1300, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <button onClick={() => navigate('/properties')} className="btn btn-ghost" style={{ marginBottom: 12 }}>&larr; Back to Properties</button>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-0)', margin: 0 }}>
          Property &amp; Unit Onboarding
        </h1>
        <p style={{ fontSize: '.88rem', color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 }}>
          Bring your full portfolio onto GAM in one shot. One CSV row per unit;
          the property is created automatically if it doesn't already exist
          (matched on name + street address). Tenants come next — once your
          properties and units are in place, head to Tenant Onboarding.
        </p>
      </div>

      {successBanner && (
        <div style={{
          padding: 14, marginBottom: 16, background: 'var(--bg-2)',
          borderLeft: '3px solid #16a34a', borderRadius: 6,
          fontSize: '.9rem', color: 'var(--text-0)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <CheckCircle2 size={18} style={{ color: '#16a34a', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <strong>{successBanner}</strong>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4 }}>
              Next step: head to <a href="/tenant-onboarding" style={{ color: 'var(--gold)' }}>Tenant Onboarding</a> to bring in your tenants + leases.
            </div>
          </div>
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

      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 12 }}>1. Pick the source platform</h2>
        <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
          GAM recognizes the standard export column names from each supported platform. Pick yours
          and we'll auto-map the columns; the preview step lets you correct anything that didn't land cleanly.
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
            Download the GAM template, fill in your properties + units, then upload it below. One row per unit. For a property with multiple units, repeat the property fields on each unit's row.
          </p>
        ) : (
          <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
            {source === 'buildium' && 'Export from Buildium: Rentals > Reports > Rental Property List (or Unit List). We map the property + unit columns automatically.'}
            {source === 'appfolio' && 'Export from AppFolio: Reports > Property List or Unit List > Export to CSV.'}
            {source === 'doorloop' && 'Export from DoorLoop: Properties > Export to CSV. If your export is one row per property, combine it with the Units export so each row carries both property + unit fields.'}
            {source === 'yardi' && 'Export from Voyager or Breeze: Rent Roll report (one row per unit, property fields repeat).'}
            {source === 'rentmanager' && 'Export the Property + Unit list from RentManager Reports.'}
            {source === 'propertyware' && 'Export from Propertyware: Reports > Property List + Unit List.'}
            {source === 'rentec' && 'Export from Rentec Direct: Properties > Export.'}
            {source === 'tenantcloud' && 'Export from TenantCloud: Properties > Export to CSV.'}
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
              {validateMut.isLoading ? 'Validating…' : 'Validate'}
            </button>
          </div>
        )}
      </div>

      {errorMsg && (
        <div style={{
          padding: 14, marginBottom: 16, background: 'var(--bg-2)',
          borderLeft: '3px solid #dc2626', borderRadius: 6,
          fontSize: '.9rem', color: 'var(--text-1)',
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <AlertCircle size={16} style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }} />
          <span>{errorMsg}</span>
        </div>
      )}

      {summary && punchListRows && (
        <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 12 }}>4. Preview &amp; commit</h2>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16, fontSize: '.85rem' }}>
            <div style={{ color: 'var(--text-1)' }}><strong>{summary.total}</strong> row(s)</div>
            <div style={{ color: 'var(--text-1)' }}><strong>{summary.newProperties}</strong> new propert{summary.newProperties === 1 ? 'y' : 'ies'}</div>
            <div style={{ color: 'var(--text-1)' }}><strong>{summary.newUnits}</strong> new unit{summary.newUnits === 1 ? '' : 's'}</div>
            {summary.blockers > 0 && (
              <div style={{ color: '#dc2626' }}><strong>{summary.blockers}</strong> blocker{summary.blockers === 1 ? '' : 's'}</div>
            )}
            {summary.warnings > 0 && (
              <div style={{ color: '#f59e0b' }}><strong>{summary.warnings}</strong> warning{summary.warnings === 1 ? '' : 's'}</div>
            )}
          </div>

          <div style={{ overflowX: 'auto', borderRadius: 6, border: '1px solid var(--border-0)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--bg-2)' }}>
                  <th style={th}>Row</th>
                  <th style={th}>Property</th>
                  <th style={th}>Street</th>
                  <th style={th}>City</th>
                  <th style={th}>State</th>
                  <th style={th}>Zip</th>
                  <th style={th}>Unit #</th>
                  <th style={th}>Beds</th>
                  <th style={th}>Baths</th>
                  <th style={th}>Rent</th>
                  <th style={th}>Deposit</th>
                  <th style={th}>Issues</th>
                </tr>
              </thead>
              <tbody>
                {punchListRows.map(r => {
                  const hasBlock = r.issues.some(i => i.severity === 'block')
                  return (
                    <tr key={r.rowIndex} style={{ borderTop: '1px solid var(--border-0)', background: hasBlock ? 'rgba(220,38,38,0.06)' : undefined }}>
                      <td style={td}>{r.rowIndex + 1}</td>
                      <td style={td}><EditCell value={r.propertyName} onChange={v => updateRow(r.rowIndex, 'propertyName', v)} /></td>
                      <td style={td}><EditCell value={r.street1} onChange={v => updateRow(r.rowIndex, 'street1', v)} /></td>
                      <td style={td}><EditCell value={r.city} onChange={v => updateRow(r.rowIndex, 'city', v)} /></td>
                      <td style={td}><EditCell value={r.state} onChange={v => updateRow(r.rowIndex, 'state', v)} width={60} /></td>
                      <td style={td}><EditCell value={r.zip} onChange={v => updateRow(r.rowIndex, 'zip', v)} width={80} /></td>
                      <td style={td}><EditCell value={r.unitNumber} onChange={v => updateRow(r.rowIndex, 'unitNumber', v)} width={80} /></td>
                      <td style={td}><EditCell value={r.bedrooms} onChange={v => updateRow(r.rowIndex, 'bedrooms', v)} width={50} /></td>
                      <td style={td}><EditCell value={r.bathrooms} onChange={v => updateRow(r.rowIndex, 'bathrooms', v)} width={50} /></td>
                      <td style={td}><EditCell value={r.rentAmount} onChange={v => updateRow(r.rowIndex, 'rentAmount', v)} width={80} /></td>
                      <td style={td}><EditCell value={r.securityDeposit} onChange={v => updateRow(r.rowIndex, 'securityDeposit', v)} width={80} /></td>
                      <td style={td}>
                        {r.issues.length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {r.issues.map((iss, k) => (
                              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: iss.severity === 'block' ? '#dc2626' : '#f59e0b', fontSize: '.78rem' }}>
                                {iss.severity === 'block' ? <X size={11} /> : <AlertTriangle size={11} />}
                                <span><strong>{iss.field}:</strong> {iss.message}</span>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: '#16a34a', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle2 size={12} /> ok
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleCommit}
              disabled={commitMut.isLoading || punchListRows.some(r => r.issues.some(i => i.severity === 'block'))}
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              {commitMut.isLoading ? 'Committing…' : `Commit ${summary.ready} ready row(s)`}
            </button>
            {punchListRows.some(r => r.issues.some(i => i.severity === 'block')) && (
              <span style={{ fontSize: '.82rem', color: '#dc2626' }}>
                Fix blockers above before committing.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: '.78rem', color: 'var(--text-2)', fontWeight: 600, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'top' }

function EditCell({ value, onChange, width }: { value: string; onChange: (v: string) => void; width?: number }) {
  return (
    <input
      className="input"
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{ width: width ?? 120, fontSize: '.8rem', padding: '4px 6px' }}
    />
  )
}
