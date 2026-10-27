import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from 'react-query'
import { Printer } from 'lucide-react'
import { apiPatch } from '../lib/api'

/**
 * ── 10/27 (Nic): PAPER BILLS ARE A PROPERTY'S ANSWER ────────────────────────
 *
 *   "It's a setting on the landlord page, a property level setting. Do you want
 *    to print paper copies of the bills when these are generated? Make it
 *    easier."
 *
 * Per PROPERTY, not per resident. A park that delivers to doors delivers to all
 * of them, and asking each resident one at a time was the clunky version he
 * rejected — the per-resident column drafted on 10/26 is unused and says so in
 * its own comment.
 *
 * Why anybody wants it (10/26): "We get a lot of people that still are old
 * school. Landlords that I talk to still hand deliver bills to the tenants'
 * doors on the first of each month, especially where utilities are billed back
 * and they don't exactly know what their bill is going to be."
 */
export function PropertyPaperBillsSection(
  { property, onSaved }: { property: any; onSaved: () => void },
) {
  const qc = useQueryClient()
  const current = property?.printAllBills === true
  const [on, setOn] = useState(current)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => { setOn(current); setSaved(false); setErr(null) }, [property?.id, current])

  const save = useMutation(
    (next: boolean) => apiPatch(`/properties/${property.id}/paper-bills`, { paperBills: next }),
    {
      onSuccess: (_d, next) => {
        setErr(null); setSaved(true); setOn(next)
        qc.invalidateQueries('properties'); onSaved()
      },
      onError: (e: any) => { setOn(current); setErr(e?.response?.data?.error || 'Could not save') },
    },
  )

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 4px', fontSize: '.95rem' }}>
        <Printer size={16} /> Paper bills
      </h3>
      <p style={{ fontSize: '.78rem', color: 'var(--text-3)', margin: '0 0 16px', maxWidth: 640 }}>
        Do you hand deliver bills at <strong>{property?.name}</strong>? Turn this on and the month&apos;s
        bills can be printed in one go from the Payments page — one page per household, with each
        utility&apos;s meter reading on it, ready to go under doors. Residents still get their bill by
        email either way.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: '.85rem' }}>
        <input type="checkbox" checked={on} disabled={save.isLoading}
          onChange={e => { setSaved(false); save.mutate(e.target.checked) }} />
        <span>We deliver paper bills at this property</span>
      </label>
      {err && <p style={{ color: 'var(--red)', fontSize: '.78rem', marginTop: 10 }}>{err}</p>}
      {saved && !err && (
        <p style={{ fontSize: '.75rem', color: 'var(--text-3)', marginTop: 10 }}>
          {on
            ? 'Saved — Print all outstanding is on the Payments page for this property.'
            : 'Saved — no printing prompts for this property.'}
        </p>
      )}
    </div>
  )
}
