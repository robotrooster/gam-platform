/**
 * S651 — what somebody in the renter pool is actually here for.
 *
 * Nic: "The person signs up for a, looking for a place to live, and that's it.
 * Based on their address from their ID, it shows nearby properties in a radius
 * that are onboarded on the platform. If there's nothing in the area — if
 * somebody signs up in New York and the only properties are in Illinois and
 * freaking Arizona — then it won't show them that there's anywhere close by to
 * live. They can expand their search if they're looking to move further away,
 * but that's it."
 *
 * The whole page is that sentence. No filters, no saved searches, no map: a
 * distance, a list, and a way to look further out.
 *
 * WHEN NOTHING IS NEARBY it says how far the nearest is instead of showing an
 * empty box. "Nothing within 50 miles — the closest is 780 miles away in
 * Mattoon, IL" is a fact somebody can act on. An empty screen is indistinguish-
 * able from a broken one, and this person has just paid for a background check.
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
// The shared client, not a raw fetch: it camelizes every response
// (applyCamelizeInterceptor), so this page reads openUnits / distanceMiles like
// the rest of the portal. A raw fetch here would hand back snake_case, the
// camelCase reads would all be undefined, and the page would render blank rows
// with no error anywhere. (memory: gam-camelize-wire-contract-test-gap)
import { apiGet } from '../lib/api'

const miles = (n: any) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })} mi`

export function FindAPlacePage() {
  const [radius, setRadius] = useState(50)
  const { data, isLoading, error } = useQuery<any, Error>(
    ['find-a-place', radius],
    () => apiGet(`/renter-pool/me/nearby?radiusMiles=${radius}`),
    { retry: false },
  )

  const places: any[] = data?.properties ?? []
  const choices: number[] = data?.radiusChoices ?? [25, 50, 100, 250, 500]

  return (
    <div>
      {/* .ph / .pt / .ps — the tenant portal's own header classes. It does not
          share the landlord portal's stylesheet, and a landlord class name used
          here renders as unstyled plain text.
          (memory: gam-classname-drift-heuristic) */}
      <div className="ph">
        <div>
          <h1 className="pt">Find a place</h1>
          <p className="ps">
            {data?.from?.city
              ? `Places on GAM near ${data.from.city}, ${data.from.state}`
              : 'Places on GAM near you'}
          </p>
        </div>
      </div>

      {error && (
        // The API's own sentence, not axios's "Request failed with status code
        // 409" — the 409 here is "we could not place your address on a map",
        // which is something the person can actually do something about.
        <div className="card" style={{ color: 'var(--t2)', lineHeight: 1.6 }}>
          {(error as any)?.response?.data?.error || error.message}
        </div>
      )}

      {!error && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '.8rem', color: 'var(--t2)' }}>Within</span>
            {choices.map((c) => (
              <button key={c}
                className={`btn btn-sm ${c === radius ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setRadius(c)}>
                {c} mi
              </button>
            ))}
          </div>

          {isLoading ? (
            <div className="card" style={{ color: 'var(--t3)' }}>Looking…</div>
          ) : places.length ? (
            places.map((p: any) => (
              <div key={p.id} className="card" style={{ marginBottom: 10, display: 'flex',
                                                        justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{p.name}</div>
                  <div style={{ fontSize: '.8rem', color: 'var(--t2)', marginTop: 2 }}>
                    {p.city}, {p.state}
                    {Number(p.openUnits) > 0
                      ? ` · ${p.openUnits} open`
                      : ' · nothing open right now'}
                  </div>
                </div>
                <div className="mono" style={{ whiteSpace: 'nowrap', color: 'var(--t2)' }}>
                  {miles(p.distanceMiles)}
                </div>
              </div>
            ))
          ) : data?.nearestOutsideRadius ? (
            // Not an empty box. Say where the nearest one actually is, so the
            // person can decide whether that is a distance they would move.
            <div className="card" style={{ color: 'var(--t2)', lineHeight: 1.6 }}>
              Nothing on GAM within {radius} miles of you yet. The closest is{' '}
              <b>{data.nearestOutsideRadius.name}</b> in {data.nearestOutsideRadius.city},{' '}
              {data.nearestOutsideRadius.state} — about{' '}
              {miles(data.nearestOutsideRadius.distanceMiles)} away. Widen the search above if
              you would move that far.
            </div>
          ) : (
            <div className="card" style={{ color: 'var(--t2)' }}>
              No places to show yet.
            </div>
          )}
        </>
      )}
    </div>
  )
}
