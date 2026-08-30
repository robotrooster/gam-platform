import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import { apiDelete } from '../lib/api'
import { appConfirm } from '../components/dialogs'

// S630 (Nic): "there's no possible way to delete a property that I can see."
// There wasn't — units had a delete path and properties never did, so a test
// property left behind by an earlier session sat in his portfolio permanently.
//
// The server refuses the moment the property carries a tenancy, so this does not
// need to guess: it asks, sends, and reports back whatever the server said. The
// refusal names what is on record, which is more useful than a disabled button
// that explains nothing.
export function PropertyDangerZone({ property }: { property: any }) {
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function remove() {
    setErr(null)
    const yes = await appConfirm(
      `Delete “${property.name}” and its units. This cannot be undone, and it is only possible ` +
      `because nobody has ever leased, paid or booked here — if anyone had, GAM would keep it.`,
      { title: 'Delete this property?', confirmLabel: 'Delete property', danger: true },
    )
    if (!yes) return
    setBusy(true)
    try {
      await apiDelete(`/properties/${property.id}`)
      nav('/properties')
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not delete this property.')
    } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ marginTop: 20, borderColor: 'var(--red)' }}>
      <h3 style={{ display:'flex', alignItems:'center', gap:8, margin:'0 0 4px', fontSize:'.95rem' }}>
        <Trash2 size={16} /> Delete this property
      </h3>
      <p style={{ fontSize:'.78rem', color:'var(--text-3)', margin:'0 0 14px', maxWidth:620 }}>
        Only possible while nothing has happened here — no lease, payment, booking, deposit,
        maintenance request, invited tenant or meter reading. Once any of those exist the property
        stays, because that history has to stay with it. For a property you no longer own, transfer
        it instead.
      </p>
      {err && <p style={{ color:'var(--red)', fontSize:'.8rem', margin:'0 0 12px' }}>{err}</p>}
      <button className="btn btn-ghost btn-sm" onClick={remove} disabled={busy}
        style={{ borderColor:'var(--red)', color:'var(--red)' }}>
        {busy ? 'Deleting…' : 'Delete property'}
      </button>
    </div>
  )
}
