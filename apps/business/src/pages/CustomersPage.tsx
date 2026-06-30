import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { MapPin, Pencil, Archive, CreditCard, Link2, Upload, Link2Off } from 'lucide-react'
import { Modal } from '../components/Modal'
import { parseCustomerCsv, type CustomerImportResult } from '../lib/customerCsv'

/** Days-since-last-service summary. Tinted amber after 14 days
 *  (loose "is this customer stale?" heuristic). */
function fmtLastServiced(iso: string | null): React.ReactNode {
  if (!iso) return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>
  const d = new Date(iso)
  const days = Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000))
  const label = days === 0 ? 'today'
    : days === 1 ? 'yesterday'
    : days < 14 ? `${days}d ago`
    : days < 60 ? `${days}d ago`
    : `${Math.floor(days / 30)}mo ago`
  return (
    <span style={{
      fontSize: 12,
      color: days >= 14 ? 'var(--amber)' : 'var(--text-1)',
    }}>{label}</span>
  )
}

interface CustomerRow {
  id: string
  customerType: 'individual' | 'business'
  companyName: string | null
  firstName: string; lastName: string
  email: string | null; phone: string | null
  street1: string; street2: string | null
  city: string; state: string; zip: string
  lat: string | null; lon: string | null
  unitCount?: number
  status: string
  createdAt: string
  lastServicedAt: string | null
  // S508 saved payment method indicators
  hasSavedCard?: boolean
  paymentMethodBrand?: string | null
  paymentMethodLast4?: string | null
  paymentMethodExpMonth?: number | null
  paymentMethodExpYear?: number | null
}

export function CustomersPage() {
  const [rows, setRows] = useState<CustomerRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    customerType: 'individual' as 'individual' | 'business',
    companyName: '', firstName: '', lastName: '',
    email: '', phone: '',
    street1: '', street2: '',
    city: '', state: '', zip: '',
    unitCount: '1',
  })
  const [saving, setSaving] = useState(false)
  const [geocoding, setGeocoding] = useState<string | null>(null)
  const [editing, setEditing] = useState<CustomerRow | null>(null)
  const [editForm, setEditForm] = useState({
    customerType: 'individual' as 'individual' | 'business',
    companyName: '', firstName: '', lastName: '',
    email: '', phone: '',
    street1: '', street2: '',
    city: '', state: '', zip: '',
    lat: '', lon: '',
    taxExempt: false, taxExemptReason: '',
    unitCount: '1',
  })
  const [editSaving, setEditSaving] = useState(false)
  const [archiving, setArchiving] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<CustomerImportResult | null>(null)
  const [importErr, setImportErr] = useState<string | null>(null)

  const reload = async () => {
    try {
      const data = await apiGet<CustomerRow[]>('/business-customers')
      setRows(data)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load customers')
    } finally { setLoading(false) }
  }

  useEffect(() => { reload() }, [])

  // Bulk CSV import — same parser + endpoint as the onboarding wizard.
  const onImportFile = async (file: File) => {
    setImportErr(null); setImportResult(null); setImporting(true)
    try {
      const text = await file.text()
      const customers = parseCustomerCsv(text)
      if (customers.length === 0) { setImportErr('No rows found in the file'); return }
      const r = await apiPost<CustomerImportResult>('/business-customers/import', { customers })
      setImportResult(r.data)
      await reload()
    } catch (e: any) {
      setImportErr(e?.response?.data?.error || 'Import failed')
    } finally { setImporting(false) }
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setSaving(true)
    try {
      await apiPost('/business-customers', {
        customerType: form.customerType,
        companyName: form.customerType === 'business' ? form.companyName : undefined,
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email || undefined,
        phone: form.phone || undefined,
        street1: form.street1, street2: form.street2 || undefined,
        city: form.city, state: form.state, zip: form.zip,
        unitCount: Math.max(0, Math.round(Number(form.unitCount) || 1)),
      })
      setForm({
        customerType: 'individual',
        companyName: '', firstName: '', lastName: '',
        email: '', phone: '',
        street1: '', street2: '', city: '', state: '', zip: '',
        unitCount: '1',
      })
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setSaving(false) }
  }

  const startEdit = (r: CustomerRow) => {
    setEditing(r)
    setEditForm({
      customerType: r.customerType,
      companyName: r.companyName ?? '',
      firstName: r.firstName, lastName: r.lastName,
      email: r.email ?? '', phone: r.phone ?? '',
      street1: r.street1, street2: r.street2 ?? '',
      city: r.city, state: r.state, zip: r.zip,
      lat: r.lat ?? '', lon: r.lon ?? '',
      taxExempt: (r as any).taxExempt ?? false,
      taxExemptReason: (r as any).taxExemptReason ?? '',
      unitCount: String((r as any).unitCount ?? 1),
    })
  }

  const onEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    setErr(null); setEditSaving(true)
    try {
      // Only send lat/lon if BOTH supplied or BOTH cleared (the
      // backend rejects partial updates with 400).
      const latStr = editForm.lat.trim()
      const lonStr = editForm.lon.trim()
      const bothEmpty = latStr === '' && lonStr === ''
      const bothFilled = latStr !== '' && lonStr !== ''
      const coordPatch = bothEmpty
        ? { lat: null, lon: null }
        : bothFilled
          ? { lat: Number(latStr), lon: Number(lonStr) }
          : {}  // mismatched — skip; user can submit a second time

      await apiPatch(`/business-customers/${editing.id}`, {
        customerType: editForm.customerType,
        companyName: editForm.customerType === 'business' ? editForm.companyName : null,
        firstName: editForm.firstName,
        lastName: editForm.lastName,
        email: editForm.email || null,
        phone: editForm.phone || null,
        street1: editForm.street1, street2: editForm.street2 || null,
        city: editForm.city, state: editForm.state, zip: editForm.zip,
        taxExempt: editForm.taxExempt,
        taxExemptReason: editForm.taxExempt ? (editForm.taxExemptReason.trim() || null) : null,
        unitCount: Math.max(0, Math.round(Number(editForm.unitCount) || 1)),
        ...coordPatch,
      })
      setEditing(null)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setEditSaving(false) }
  }

  const onArchive = async (r: CustomerRow) => {
    const label = r.companyName || `${r.firstName} ${r.lastName}`
    if (!window.confirm(`Archive ${label}? They'll be hidden from the active list and won't appear on new routes.`)) return
    setArchiving(r.id); setErr(null)
    try {
      await apiPost(`/business-customers/${r.id}/archive`)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Archive failed')
    } finally { setArchiving(null) }
  }

  const onSendCardUpdate = async (r: CustomerRow) => {
    if (!r.email) {
      setErr('Customer has no email on file — add one first.')
      return
    }
    const label = r.companyName || `${r.firstName} ${r.lastName}`
    if (!window.confirm(`Email ${label} a secure link to update their card on file?`)) return
    setErr(null)
    try {
      await apiPost(`/business-customers/${r.id}/send-card-update-link`, {})
      setErr(null)
      window.alert(`Update-card link sent to ${r.email}. Expires in 7 days.`)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Send failed')
    }
  }

  const onAccountLink = async (r: CustomerRow) => {
    const label = r.companyName || `${r.firstName} ${r.lastName}`
    setErr(null)
    try {
      const resp = await apiPost<{ url: string }>(`/business-customers/${r.id}/portal-link`, {})
      const url = resp.data.url
      try { await navigator.clipboard?.writeText(url) } catch { /* clipboard may be blocked */ }
      const emailToo = r.email && window.confirm(
        `Account link copied to clipboard:\n${url}\n\nAlso email it to ${r.email}?`)
      if (emailToo) {
        await apiPost(`/business-customers/${r.id}/portal-link`, { sendEmail: true })
        window.alert(`Account link emailed to ${r.email}.`)
      } else {
        window.alert(`Account link for ${label} copied to clipboard.`)
      }
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not create the account link')
    }
  }

  const onRevokePortal = async (r: CustomerRow) => {
    const label = r.companyName || `${r.firstName} ${r.lastName}`
    if (!window.confirm(
      `Revoke ${label}'s portal access? Their current link stops working immediately. ` +
      `You can issue a fresh link anytime with "Account link".`)) return
    setErr(null); setRevoking(r.id)
    try {
      const resp = await apiPost<{ revoked: number }>(`/business-customers/${r.id}/revoke-portal-access`, {})
      window.alert(resp.data.revoked > 0
        ? `Portal access revoked for ${label}.`
        : `${label} had no active portal link.`)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not revoke portal access')
    } finally { setRevoking(null) }
  }

  const onGeocode = async (id: string) => {
    setErr(null); setGeocoding(id)
    try {
      await apiPost(`/business-customers/${id}/geocode`)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Geocode failed')
    } finally { setGeocoding(null) }
  }

  const ungeocodedCount = rows.filter(r => r.lat === null).length

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }}>
          Customers
        </h1>
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, cursor: importing ? 'default' : 'pointer',
          padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
          border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 13, fontWeight: 500,
          opacity: importing ? 0.6 : 1,
        }}>
          <Upload size={14} /> {importing ? 'Importing…' : 'Import CSV'}
          <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} disabled={importing}
            onChange={e => { const f = e.target.files?.[0]; if (f) onImportFile(f); e.target.value = '' }} />
        </label>
      </div>
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 24 }}>
        Your service roster. New customers are auto-geocoded on create;
        if the address can't be resolved, you'll see a "Geocode" button
        on the row to retry after fixing it.
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {ungeocodedCount > 0 && (
        <div style={warnStyle}>
          {ungeocodedCount} customer{ungeocodedCount === 1 ? '' : 's'}{' '}
          without coordinates won't appear on generated routes until
          backfilled. Click "Geocode" on each row to retry.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div>
          {loading ? (
            <div style={{ color: 'var(--text-2)' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={emptyStyle}>No customers yet. Add one to get started.</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Address</th>
                  <th style={thStyle}>Coords</th>
                  <th style={thStyle}>Last serviced</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                    <td style={tdStyle}>
                      {r.firstName} {r.lastName}
                      {r.companyName && (
                        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{r.companyName}</div>
                      )}
                      {r.hasSavedCard && (
                        <div style={{
                          marginTop: 4, display: 'inline-flex' as const, alignItems: 'center', gap: 4,
                          padding: '2px 6px', borderRadius: 4,
                          background: 'rgba(34,197,94,.08)',
                          border: '1px solid rgba(34,197,94,.4)',
                          fontSize: 10, color: 'var(--green, #22c55e)',
                          fontWeight: 600, letterSpacing: 0.3,
                        }} title={r.paymentMethodBrand && r.paymentMethodLast4
                          ? `${r.paymentMethodBrand.toUpperCase()} ····${r.paymentMethodLast4}`
                          : 'Auto-pay enabled'}>
                          AUTO-PAY · {r.paymentMethodBrand?.toUpperCase()} {r.paymentMethodLast4 ? `····${r.paymentMethodLast4}` : ''}
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>
                      {r.street1}, {r.city}, {r.state} {r.zip}
                    </td>
                    <td style={tdStyle}>
                      {r.lat ? (
                        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {Number(r.lat).toFixed(3)}, {Number(r.lon).toFixed(3)}
                        </code>
                      ) : (
                        <span style={{ color: 'var(--amber)', fontSize: 12 }}>
                          missing
                        </span>
                      )}
                    </td>
                    <td style={tdStyle}>{fmtLastServiced(r.lastServicedAt)}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {!r.lat && (
                          <button
                            onClick={() => onGeocode(r.id)}
                            disabled={geocoding === r.id}
                            style={iconBtnStyle('gold', geocoding === r.id)}
                          >
                            <MapPin size={12} />
                            {geocoding === r.id ? 'Geocoding…' : 'Geocode'}
                          </button>
                        )}
                        <button onClick={() => startEdit(r)}
                          style={iconBtnStyle('default', false)}>
                          <Pencil size={12} /> Edit
                        </button>
                        {r.email && (
                          <button onClick={() => onSendCardUpdate(r)}
                            style={iconBtnStyle('default', false)}
                            title={r.hasSavedCard
                              ? 'Email a link to replace the saved card'
                              : 'Email a link to add a card to file'}>
                            <CreditCard size={12} />
                            {r.hasSavedCard ? 'Update card' : 'Add card'}
                          </button>
                        )}
                        <button onClick={() => onAccountLink(r)}
                          style={iconBtnStyle('default', false)}
                          title="Copy or email this customer a link to view & pay their invoices">
                          <Link2 size={12} /> Account link
                        </button>
                        <button onClick={() => onRevokePortal(r)}
                          disabled={revoking === r.id}
                          style={iconBtnStyle('amber', revoking === r.id)}
                          title="Immediately disable this customer's portal link (e.g. if it leaked or the relationship ended)">
                          <Link2Off size={12} />
                          {revoking === r.id ? 'Revoking…' : 'Revoke link'}
                        </button>
                        <button onClick={() => onArchive(r)}
                          disabled={archiving === r.id}
                          style={iconBtnStyle('amber', archiving === r.id)}>
                          <Archive size={12} />
                          {archiving === r.id ? 'Archiving…' : 'Archive'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <h2 style={h2Style}>Add a customer</h2>
          <form onSubmit={onSubmit} style={formStyle}>
            <label style={labelStyle}>Customer type</label>
            <select value={form.customerType}
              onChange={e => setForm({ ...form, customerType: e.target.value as any })}
              style={inputStyle}>
              <option value="individual">Individual</option>
              <option value="business">Business</option>
            </select>

            {form.customerType === 'business' && (
              <>
                <label style={labelStyle}>Company name</label>
                <input value={form.companyName}
                  onChange={e => setForm({ ...form, companyName: e.target.value })}
                  required style={inputStyle} />
              </>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>
                  {form.customerType === 'business' ? 'Contact first' : 'First name'}
                </label>
                <input value={form.firstName}
                  onChange={e => setForm({ ...form, firstName: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Last name</label>
                <input value={form.lastName}
                  onChange={e => setForm({ ...form, lastName: e.target.value })}
                  required style={inputStyle} />
              </div>
            </div>

            <label style={labelStyle}>Email (optional)</label>
            <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
              type="email" style={inputStyle} />

            <label style={labelStyle}>Phone (optional)</label>
            <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })}
              style={inputStyle} />

            <label style={labelStyle}>Street</label>
            <input value={form.street1}
              onChange={e => setForm({ ...form, street1: e.target.value })}
              required style={inputStyle} />

            <label style={labelStyle}>Unit / apartment (optional)</label>
            <input value={form.street2}
              onChange={e => setForm({ ...form, street2: e.target.value })}
              style={inputStyle} />

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>City</label>
                <input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>State</label>
                <input value={form.state} onChange={e => setForm({ ...form, state: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>ZIP</label>
                <input value={form.zip} onChange={e => setForm({ ...form, zip: e.target.value })}
                  required style={inputStyle} />
              </div>
            </div>

            <div style={{ marginTop: 12, maxWidth: 200 }}>
              <label style={labelStyle}>Units (e.g. # cans)</label>
              <input value={form.unitCount} onChange={e => setForm({ ...form, unitCount: e.target.value })}
                type="number" min="0" step="1" style={inputStyle} />
            </div>

            <button type="submit" disabled={saving}
              style={{ ...btnStyle, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Add customer'}
            </button>
          </form>
        </div>
      </div>

      {editing && (
        <Modal title={`Edit ${editing.companyName || `${editing.firstName} ${editing.lastName}`}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" onClick={() => setEditing(null)}
                style={cancelBtnStyle}>Cancel</button>
              <button type="submit" form="customer-edit" disabled={editSaving}
                style={{ ...saveBtnStyle, opacity: editSaving ? 0.6 : 1 }}>
                {editSaving ? 'Saving…' : 'Save changes'}
              </button>
            </>
          }>
          <form id="customer-edit" onSubmit={onEditSubmit}>
            <label style={labelStyle}>Customer type</label>
            <select value={editForm.customerType}
              onChange={e => setEditForm({ ...editForm, customerType: e.target.value as any })}
              style={inputStyle}>
              <option value="individual">Individual</option>
              <option value="business">Business</option>
            </select>
            {editForm.customerType === 'business' && (
              <>
                <label style={labelStyle}>Company name</label>
                <input value={editForm.companyName}
                  onChange={e => setEditForm({ ...editForm, companyName: e.target.value })}
                  required style={inputStyle} />
              </>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>First name</label>
                <input value={editForm.firstName}
                  onChange={e => setEditForm({ ...editForm, firstName: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Last name</label>
                <input value={editForm.lastName}
                  onChange={e => setEditForm({ ...editForm, lastName: e.target.value })}
                  required style={inputStyle} />
              </div>
            </div>
            <label style={labelStyle}>Email (optional)</label>
            <input type="email" value={editForm.email}
              onChange={e => setEditForm({ ...editForm, email: e.target.value })}
              style={inputStyle} />
            <label style={labelStyle}>Phone (optional)</label>
            <input value={editForm.phone}
              onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
              style={inputStyle} />
            <label style={labelStyle}>Street</label>
            <input value={editForm.street1}
              onChange={e => setEditForm({ ...editForm, street1: e.target.value })}
              required style={inputStyle} />
            <label style={labelStyle}>Unit / apartment (optional)</label>
            <input value={editForm.street2}
              onChange={e => setEditForm({ ...editForm, street2: e.target.value })}
              style={inputStyle} />
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>City</label>
                <input value={editForm.city}
                  onChange={e => setEditForm({ ...editForm, city: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>State</label>
                <input value={editForm.state}
                  onChange={e => setEditForm({ ...editForm, state: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>ZIP</label>
                <input value={editForm.zip}
                  onChange={e => setEditForm({ ...editForm, zip: e.target.value })}
                  required style={inputStyle} />
              </div>
            </div>
            <div style={{ marginTop: 12, maxWidth: 200 }}>
              <label style={labelStyle}>Units (e.g. # cans)</label>
              <input value={editForm.unitCount}
                onChange={e => setEditForm({ ...editForm, unitCount: e.target.value })}
                type="number" min="0" step="1" style={inputStyle} />
            </div>
            <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-2)', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
                Coordinates (optional manual override). Leave both blank to clear; supply both to set.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <label style={labelStyle}>Latitude</label>
                  <input value={editForm.lat}
                    onChange={e => setEditForm({ ...editForm, lat: e.target.value })}
                    placeholder="33.4484" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Longitude</label>
                  <input value={editForm.lon}
                    onChange={e => setEditForm({ ...editForm, lon: e.target.value })}
                    placeholder="-112.0740" style={inputStyle} />
                </div>
              </div>
            </div>
            {/* S506: tax exemption */}
            <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-2)', borderRadius: 8 }}>
              <label style={{
                display: 'flex' as const, alignItems: 'center', gap: 8,
                fontSize: 13, color: 'var(--text-1)', cursor: 'pointer',
              }}>
                <input type="checkbox" checked={editForm.taxExempt}
                  onChange={e => setEditForm({ ...editForm, taxExempt: e.target.checked })} />
                <span>Tax-exempt customer (resale certificate, nonprofit, government)</span>
              </label>
              {editForm.taxExempt && (
                <>
                  <label style={{ ...labelStyle, marginTop: 10 }}>Exemption reason (optional)</label>
                  <input value={editForm.taxExemptReason}
                    onChange={e => setEditForm({ ...editForm, taxExemptReason: e.target.value })}
                    placeholder="Resale cert #1234 / 501(c)(3) #..."
                    style={inputStyle} />
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                    Every invoice, quote, and POS sale for this customer is zero-tax.
                  </div>
                </>
              )}
            </div>
          </form>
        </Modal>
      )}

      {(importResult || importErr) && (
        <Modal title="Customer import"
          onClose={() => { setImportResult(null); setImportErr(null) }}>
          {importErr ? (
            <div style={errStyle}>{importErr}</div>
          ) : importResult && (
            <div style={{ fontSize: 13, color: 'var(--text-1)' }}>
              Imported <strong style={{ color: 'var(--green, #22c55e)' }}>{importResult.created}</strong>
              {' '}of {importResult.total}.
              {importResult.skipped > 0 && (
                <div style={{ marginTop: 8, color: 'var(--text-2)' }}>
                  {importResult.skipped} skipped:
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {importResult.errors.slice(0, 10).map((e, i) => (
                      <li key={i}>Row {e.row}: {e.reason}</li>
                    ))}
                    {importResult.errors.length > 10 && (
                      <li>…and {importResult.errors.length - 10} more</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}

export const iconBtnStyle = (
  variant: 'gold' | 'amber' | 'default',
  disabled: boolean,
): React.CSSProperties => ({
  padding: '6px 10px',
  background: 'var(--bg-2)',
  color: variant === 'gold' ? 'var(--gold)' : variant === 'amber' ? 'var(--amber)' : 'var(--text-1)',
  border: '1px solid var(--border-1)',
  borderRadius: 6, fontSize: 12,
  cursor: disabled ? 'not-allowed' : 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4,
  opacity: disabled ? 0.6 : 1,
})

export const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
}
export const saveBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
}

const h2Style: React.CSSProperties = {
  fontFamily: 'var(--font-body)', fontSize: 18, marginTop: 0, marginBottom: 12,
}
const formStyle: React.CSSProperties = {
  padding: 20, background: 'var(--bg-1)',
  border: '1px solid var(--border-0)', borderRadius: 12,
}
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse',
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden',
}
const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '12px 16px', fontSize: 12,
  color: 'var(--text-2)', textTransform: 'uppercase',
  letterSpacing: 1, background: 'var(--bg-2)',
}
const tdStyle: React.CSSProperties = {
  padding: '14px 16px', fontSize: 14, color: 'var(--text-1)',
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box',
}
const btnStyle: React.CSSProperties = {
  width: '100%', padding: '12px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600, marginTop: 20, cursor: 'pointer',
}
const errStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 8, fontSize: 13,
}
const warnStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--amber-bg)', color: 'var(--amber)',
  border: '1px solid var(--amber)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center',
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
}
