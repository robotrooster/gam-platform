/**
 * 10/20 (Nic) — BRINGING IN THE RESERVATIONS THAT ALREADY EXIST.
 *
 *   "I said import because I'm importing a fucking schedule for people that are
 *    coming. I have other reservations that are texted to me. It's two
 *    things... The file importer gets all my other reservations in there that
 *    were booked first... The people that have been texting me are the newer
 *    reservations. They don't get a spot if there's no spot to put them. That's
 *    why the importer happens first, and then the typed by hand ones come
 *    after."
 *
 * Two doors on one screen, in the order they are meant to be used: the old
 * system's file first, then the ones out of the text threads. The screen says so
 * out loud when the file has not been brought in yet, because the cost of
 * getting the order wrong is a guest arriving to find somebody on their space.
 *
 * NOTHING ON THIS SCREEN EMAILS ANYBODY. Checking the file writes nothing at
 * all (the server runs the whole import and rolls it back, so the spaces it
 * shows are the spaces it really picked); bringing them in writes the
 * reservations and sends not one message. These guests have already been told.
 */
import { useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'
import { humanize } from '@gam/shared'

const fmt = (n: any) => n != null && n !== '' ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'

/**
 * WHY A STAY CANNOT BE MOVED OFF ITS SPACE, in words. unit_bookings.lock_reason
 * is a stored value and nothing stored is ever printed raw.
 */
export const STAY_LOCK_REASON_LABEL: Record<string, string> = {
  promised_before_gam: 'Promised this space before GAM — brought in from the old system',
  promised_at_the_counter: 'Promised this space at the desk',
}
/** A locked stay with no reason recorded: somebody ticked the box on the form. */
export const STAY_LOCK_REASON_FALLBACK = 'Locked to this space by hand'

export const stayLockWords = (lockReason: string | null | undefined): string =>
  (lockReason && STAY_LOCK_REASON_LABEL[lockReason]) || STAY_LOCK_REASON_FALLBACK

/** Which door a reservation came in through. */
export const MIGRATED_DOOR_LABEL: Record<string, string> = {
  file: 'Brought in from the old system',
  hand: 'Typed in from a text',
}

/**
 * The names the preview calls each thing a row can be wrong about. A field name
 * out of the server ("guestName") is a stored identifier and never printed raw;
 * humanize() would make "Guestname" of it, which is worse than either.
 */
export const IMPORT_FIELD_LABEL: Record<string, string> = {
  guestName: 'The guest',
  email: 'Email',
  phone: 'Phone',
  propertyName: 'Park',
  unitNumber: 'Space',
  checkIn: 'Arrival',
  checkOut: 'Departure',
  nights: 'Nights',
  totalAmount: 'Price',
  depositPaid: 'Deposit',
  depositMethod: 'Deposit',
  externalRef: 'This reservation',
  notes: 'Notes',
}

/** How a deposit that never came through GAM was handed over. */
export const OFF_PLATFORM_DEPOSIT_METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  check: 'Check',
  money_order: 'Money order',
  bank_deposit: 'Deposited at the bank',
  other: 'Some other way / not recorded',
}

type Door = 'file' | 'hand'

export interface ImportRow {
  guestName?: string | null
  email?: string | null
  phone?: string | null
  propertyName?: string | null
  unitNumber?: string | null
  checkIn?: string | null
  checkOut?: string | null
  nights?: string | number | null
  totalAmount?: string | number | null
  depositPaid?: string | number | null
  depositMethod?: string | null
  depositRef?: string | null
  externalRef?: string | null
  notes?: string | null
  toldOutsideGam?: boolean | null
  extra?: Record<string, any> | null
}

const emptyTyped = (): ImportRow => ({
  guestName: '', email: '', phone: '', unitNumber: '', checkIn: '', checkOut: '',
  totalAmount: '', depositPaid: '', depositMethod: '', depositRef: '', notes: '',
  toldOutsideGam: true,
})

/** A row as the preview hands it back, carried straight back on the next check. */
const backToInput = (r: any): ImportRow => ({
  guestName: r.guestName, email: r.email, phone: r.phone, propertyName: r.propertyName,
  unitNumber: r.unitNumber, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights,
  totalAmount: r.totalAmount, depositPaid: r.depositPaid, depositMethod: r.depositMethod,
  depositRef: r.depositRef, externalRef: r.externalRef, notes: r.notes,
  toldOutsideGam: r.toldOutsideGam, extra: r.extra,
})

export function ReservationImportModal({ propertyId, propertyName, onClose, onDone }: {
  propertyId: string
  propertyName: string
  onClose: () => void
  onDone: (created: number) => void
}) {
  const [door, setDoor] = useState<Door>('file')
  const [csv, setCsv] = useState('')
  const [platform, setPlatform] = useState('')
  const [typed, setTyped] = useState<ImportRow[]>([emptyTyped()])
  const [rows, setRows] = useState<ImportRow[] | null>(null)   // what the preview is OF
  const [preview, setPreview] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [columns, setColumns] = useState<any[] | null>(null)
  const [showColumns, setShowColumns] = useState(false)

  useEffect(() => {
    let live = true
    apiGet('/bookings/import/template')
      .then((r: any) => { if (live) setColumns(r?.data?.columns ?? r?.columns ?? null) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  const blockers = preview?.summary?.blockers ?? 0
  const ready = preview?.summary?.ready ?? 0

  // The API's body parser takes 100 KB in one request, so a season file bigger
  // than that is split here rather than coming back as a bare 413 with nothing
  // to do about it.
  const CSV_LIMIT = 90_000

  const check = async (next?: ImportRow[]) => {
    if (!next && door === 'file' && csv.length > CSV_LIMIT) {
      setErr(`That file is ${Math.round(csv.length / 1024)} KB and GAM takes about `
        + `${Math.round(CSV_LIMIT / 1024)} KB in one go — roughly 800 reservations. Split it by season or by `
        + 'park and bring the parts in one after another; nothing is brought in twice.')
      return
    }
    setBusy(true); setErr('')
    try {
      const body: any = { propertyId, door }
      if (next) { body.rows = next } else if (door === 'file') { body.csv = csv; if (platform.trim()) body.claimedPlatformName = platform.trim() } else { body.rows = typed }
      const r: any = await apiPost('/bookings/import/validate', body)
      const data = r?.data ?? r
      setPreview(data)
      setRows((data?.rows ?? []).map(backToInput))
    } catch (e: any) {
      setErr(e?.response?.data?.error || e?.message || 'That could not be read.')
      setPreview(null); setRows(null)
    } finally { setBusy(false) }
  }

  const bringThemIn = async () => {
    if (!rows) return
    setBusy(true); setErr('')
    try {
      const r: any = await apiPost('/bookings/import/commit', { propertyId, door, rows })
      const created = (r?.data ?? r)?.committed?.created ?? 0
      const skipped = (r?.data ?? r)?.committed?.skipped ?? 0
      toast(created === 0
        ? 'Nothing new — every one of those was already on the board.'
        : `${created} reservation${created === 1 ? '' : 's'} on the board at ${propertyName}`
          + `${skipped ? `, ${skipped} already there` : ''}. Nobody was emailed.`)
      onDone(created)
    } catch (e: any) {
      setErr(e?.response?.data?.error || e?.message || 'They could not be brought in.')
    } finally { setBusy(false) }
  }

  const editRow = (i: number, patch: Partial<ImportRow>) => {
    setRows(prev => prev ? prev.map((r, n) => n === i ? { ...r, ...patch } : r) : prev)
  }
  const leaveOut = (i: number) => {
    setRows(prev => {
      const next = (prev ?? []).filter((_, n) => n !== i)
      if (next.length) check(next)
      else { setPreview(null); setRows(null) }
      return next
    })
  }

  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onClose() }}>
      <div className="modal" style={{ maxWidth: 1040 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Bring in reservations · {propertyName}</div>

        {/* THE ORDER, as the first thing on the screen. */}
        <div style={{ display: 'flex', gap: 8, margin: '10px 0 6px' }}>
          {(['file', 'hand'] as Door[]).map(d => (
            <button
              key={d}
              className={`btn btn-sm ${door === d ? 'btn-primary' : 'btn-ghost'}`}
              disabled={busy}
              onClick={() => { setDoor(d); setPreview(null); setRows(null); setErr('') }}
            >
              {d === 'file' ? '1 · The old system\'s schedule (a file)' : '2 · Typed in from a text'}
            </button>
          ))}
        </div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 12 }}>
          {door === 'file'
            ? 'These booked first, so they go in first and keep the spaces they were promised. Nobody is emailed — '
              + 'they were told they were confirmed in the old system.'
            : 'The newer ones, into whatever is left after the old system\'s file has landed. Nobody is emailed.'}
        </div>

        {door === 'file' && !preview && (
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>
              Paste the export, or choose the file
              <textarea
                value={csv}
                onChange={e => setCsv(e.target.value)}
                rows={8}
                placeholder={'Guest,Email,Site,Arrive,Depart,Total,Deposit\nDale Carter,dale@example.com,RV 14,03/06/2027,03/13/2027,286.75,28.68'}
                style={{ width: '100%', marginTop: 6, fontFamily: 'monospace', fontSize: '.76rem' }}
              />
            </label>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={e => {
                const file = e.target.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = () => setCsv(String(reader.result ?? ''))
                reader.readAsText(file)
              }}
              style={{ fontSize: '.78rem' }}
            />
            <label style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>
              What software did it come out of? <span style={{ color: 'var(--text-3)' }}>(optional)</span>
              <input value={platform} onChange={e => setPlatform(e.target.value)}
                placeholder="Campground Master, RMS, a spreadsheet…"
                style={{ width: '100%', marginTop: 6 }} />
            </label>
            <div>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowColumns(v => !v)}>
                {showColumns ? 'Hide' : 'Show'} the column names GAM reads
              </button>
              {showColumns && columns && (
                <div style={{ marginTop: 8, fontSize: '.74rem', color: 'var(--text-3)', lineHeight: 1.6 }}>
                  {columns.map((c: any) => (
                    <div key={c.field}>
                      <strong style={{ color: 'var(--text-2)' }}>{humanize(c.field)}:</strong> {c.names.slice(0, 10).join(', ')}
                    </div>
                  ))}
                  <div style={{ marginTop: 6 }}>
                    A column GAM does not recognize is kept on the reservation, not thrown away.
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {door === 'hand' && !preview && (
          <div style={{ display: 'grid', gap: 10 }}>
            {typed.map((r, i) => (
              <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10,
                                    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                <Field label="Guest's name" value={r.guestName} onChange={v => setTyped(p => p.map((x, n) => n === i ? { ...x, guestName: v } : x))} />
                <Field label="Email" value={r.email} onChange={v => setTyped(p => p.map((x, n) => n === i ? { ...x, email: v } : x))} />
                <Field label="Phone" value={r.phone} onChange={v => setTyped(p => p.map((x, n) => n === i ? { ...x, phone: v } : x))} />
                <Field label="Arrives" value={r.checkIn} placeholder="2027-03-06" onChange={v => setTyped(p => p.map((x, n) => n === i ? { ...x, checkIn: v } : x))} />
                <Field label="Leaves" value={r.checkOut} placeholder="2027-03-13" onChange={v => setTyped(p => p.map((x, n) => n === i ? { ...x, checkOut: v } : x))} />
                <Field label="Space promised" value={r.unitNumber} placeholder="leave empty and GAM places them"
                  onChange={v => setTyped(p => p.map((x, n) => n === i ? { ...x, unitNumber: v } : x))} />
                <Field label="Price for the stay" value={r.totalAmount} placeholder="the park's rate if empty"
                  onChange={v => setTyped(p => p.map((x, n) => n === i ? { ...x, totalAmount: v } : x))} />
                <Field label="Deposit already paid" value={r.depositPaid} placeholder="0.00"
                  onChange={v => setTyped(p => p.map((x, n) => n === i ? { ...x, depositPaid: v } : x))} />
                {typed.length > 1 && (
                  <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'end' }}
                    onClick={() => setTyped(p => p.filter((_, n) => n !== i))}>Remove</button>
                )}
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }}
              onClick={() => setTyped(p => [...p, emptyTyped()])}>Add another</button>
          </div>
        )}

        {preview && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontSize: '.84rem' }}>
              <strong>{ready}</strong> going on the board
              {preview.summary.locked > 0 && <> · <strong>{preview.summary.locked}</strong> keeping a promised space</>}
              {preview.summary.placed > 0 && <> · <strong>{preview.summary.placed}</strong> placed by GAM</>}
              {preview.summary.alreadyIn > 0 && <> · <strong>{preview.summary.alreadyIn}</strong> already here</>}
              {preview.summary.depositsRecorded > 0 && (
                <> · <strong>{preview.summary.depositsRecorded}</strong> deposits already paid ({fmt(preview.summary.depositTotal)})</>
              )}
            </div>
            {blockers > 0 && (
              <div style={{ fontSize: '.8rem', color: 'var(--red,#ff6b81)', lineHeight: 1.5 }}>
                {blockers} thing{blockers === 1 ? '' : 's'} need a look before any of these can go on. Nothing is
                brought in until every one of them is settled — a space with two claims on it is two rigs on one pad.
              </div>
            )}
            {(preview.notes ?? []).map((n: string, i: number) => (
              <div key={i} style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.5,
                                    borderLeft: '3px solid var(--gold)', paddingLeft: 10 }}>{n}</div>
            ))}

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '.78rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-3)' }}>
                    <th style={{ padding: '6px 8px' }}>Guest</th>
                    <th style={{ padding: '6px 8px' }}>Dates</th>
                    <th style={{ padding: '6px 8px' }}>Space</th>
                    <th style={{ padding: '6px 8px' }}>Stay</th>
                    <th style={{ padding: '6px 8px' }}>Deposit in</th>
                    <th style={{ padding: '6px 8px' }}>Already told</th>
                    <th style={{ padding: '6px 8px' }} />
                  </tr>
                </thead>
                <tbody>
                  {(preview.rows ?? []).map((r: any, i: number) => {
                    const edited = rows?.[i] ?? {}
                    return (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)',
                                           opacity: r.alreadyIn ? 0.6 : 1 }}>
                        <td style={{ padding: '6px 8px' }}>
                          <div>{r.guestName || <em style={{ color: 'var(--text-3)' }}>no name</em>}</div>
                          <div style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>{r.email || 'no email'}</div>
                        </td>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                          {r.checkIn || '—'} → {r.checkOut || '—'}
                          {r.nights != null && <div style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>{r.nights} nights</div>}
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <input
                            value={String(edited.unitNumber ?? '')}
                            placeholder={r.siteNumber && r.placedByGam ? `${r.siteNumber} (GAM's pick)` : 'GAM places them'}
                            onChange={e => editRow(i, { unitNumber: e.target.value })}
                            style={{ width: 120 }}
                          />
                          {r.lockedToSite && r.siteNumber && (
                            <div style={{ color: 'var(--gold)', fontSize: '.72rem', marginTop: 2 }}>
                              🔒 {r.siteNumber} — {STAY_LOCK_REASON_LABEL.promised_before_gam}{/* wire-ok: a local label map keyed by the stored lock reason, not a field off a response */}
                            </div>
                          )}
                          {r.placedByGam && (
                            <div style={{ color: 'var(--text-3)', fontSize: '.72rem', marginTop: 2 }}>
                              {r.siteNumber} — not promised, so GAM may move them to fit more in
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <input value={String(edited.totalAmount ?? '')} onChange={e => editRow(i, { totalAmount: e.target.value })}
                            style={{ width: 90 }} />
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <input value={String(edited.depositPaid ?? '')} onChange={e => editRow(i, { depositPaid: e.target.value })}
                            style={{ width: 80 }} />
                          {Number(edited.depositPaid ?? 0) > 0 && (
                            <select value={String(edited.depositMethod ?? '')}
                              onChange={e => editRow(i, { depositMethod: e.target.value || null })}
                              style={{ marginTop: 4, width: 150, fontSize: '.72rem' }}>
                              <option value="">How was it paid?</option>
                              {Object.entries(OFF_PLATFORM_DEPOSIT_METHOD_LABEL).map(([k, label]) => (
                                <option key={k} value={k}>{label}</option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '.74rem' }}>
                            <input type="checkbox" checked={edited.toldOutsideGam !== false}
                              onChange={e => editRow(i, { toldOutsideGam: e.target.checked })} />
                            told already
                          </label>
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => leaveOut(i)}>Leave out</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* The things that need a look, under the table where they can be read as sentences. */}
            {(preview.rows ?? []).map((r: any, i: number) => {
              const issues = r.issues ?? []
              if (!issues.length) return null
              return (
                <div key={i} style={{ fontSize: '.76rem', lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--text-2)' }}>Row {i + 1} · {r.guestName || 'no name'}</strong>
                  {issues.map((x: any, n: number) => (
                    <div key={n} style={{ color: x.severity === 'block' ? 'var(--red,#ff6b81)' : 'var(--amber,#e8b339)' }}>
                      {IMPORT_FIELD_LABEL[x.field] ?? humanize(x.field)}: {x.message}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {err && <div style={{ fontSize: '.78rem', color: 'var(--red,#ff6b81)', marginTop: 10, lineHeight: 1.5 }}>{err}</div>}

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>Close</button>
          {preview && (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setPreview(null); setRows(null) }}>
              Back
            </button>
          )}
          {!preview && (
            <button className="btn btn-primary btn-sm" disabled={busy || (door === 'file' ? !csv.trim() : !typed.some(r => (r.guestName ?? '').trim()))}
              onClick={() => check()}>
              {busy ? 'Reading…' : door === 'file' ? 'Check the file' : 'Check these'}
            </button>
          )}
          {preview && (
            <>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => check(rows ?? undefined)}>
                {busy ? 'Checking…' : 'Check again'}
              </button>
              <button className="btn btn-primary btn-sm" disabled={busy || blockers > 0 || ready === 0}
                title={blockers > 0 ? 'Settle what needs a look first' : undefined}
                onClick={bringThemIn}>
                {busy ? 'Bringing them in…' : `Bring in ${ready} reservation${ready === 1 ? '' : 's'}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, placeholder, onChange }: {
  label: string
  value: any
  placeholder?: string
  onChange: (v: string) => void
}) {
  const id = useMemo(() => `f${Math.random().toString(36).slice(2)}`, [])
  return (
    <label htmlFor={id} style={{ fontSize: '.74rem', color: 'var(--text-3)', display: 'grid', gap: 4 }}>
      {label}
      <input id={id} value={String(value ?? '')} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} style={{ width: '100%' }} />
    </label>
  )
}
