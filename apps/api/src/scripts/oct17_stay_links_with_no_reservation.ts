/**
 * 10/17 (Nic) — ARE THERE ANY MORE LINKS THAT SELL A STAY AND HOLD NOTHING?
 *
 *   "somebody paid for a week, um, and it did not generate a stay to occupy a
 *    site. So we have some important things to address there before the
 *    schedule starts getting convoluted."
 *
 * That was one link: site rent in the cart, no site and no dates behind it,
 * paid three weeks after it went out, and the Master Schedule never heard of
 * the guest. A link cannot be made that way any more — a stay on a link now
 * holds a site from the moment it is sent, and one is chosen if nobody named
 * one — and a link already in that state now refuses to open instead of taking
 * the money (routes/posPayLinks linkNotPayable).
 *
 * This says whether any are still out there, and in which state:
 *
 *   OPEN   — somebody could still be holding this URL. Nothing will be charged
 *            on it now; it needs reissuing from the register with a site and
 *            dates, and then closing.
 *   PAID   — money was taken and no stay was placed. Check the schedule for
 *            that guest before anything else: if there is no reservation for
 *            those nights, somebody is parked on a site the software believes
 *            is empty.
 *
 * READ-ONLY. It writes nothing, with or without a flag, because every answer
 * here is a judgment call a person has to make per guest — reissue, refund, or
 * book the stay by hand. There is no safe blanket write.
 *
 *     npx ts-node -r dotenv/config --transpile-only \
 *       src/scripts/oct17_stay_links_with_no_reservation.ts
 */
import { query } from '../db'

async function main() {
  const rows = await query<{
    id: string; token: string; status: string; label: string; total: string
    property_name: string; customer_name: string | null; customer_email: string | null
    created_at: string; paid_at: string | null; stay_items: string
  }>(`
    SELECT l.id, l.token, l.status, l.label, l.total::text AS total,
           p.name AS property_name, l.customer_name, l.customer_email,
           to_char(l.created_at, 'YYYY-MM-DD') AS created_at,
           to_char(l.paid_at,    'YYYY-MM-DD') AS paid_at,
           (SELECT string_agg(i.name || ' x' || (li->>'qty'), ', ')
              FROM jsonb_array_elements(l.items) li
              JOIN pos_items i ON i.id = (li->>'id')::uuid
             WHERE i.landlord_id = l.landlord_id AND i.stay_unit IS NOT NULL) AS stay_items
      FROM pos_pay_links l
      JOIN properties p ON p.id = l.property_id
     WHERE l.booking_id IS NULL
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(l.items) li
          JOIN pos_items i ON i.id = NULLIF(li->>'id','')::uuid
         WHERE i.landlord_id = l.landlord_id AND i.stay_unit IS NOT NULL)
     ORDER BY l.status, l.created_at`)

  if (!rows.length) {
    console.log('No pay link sells a stay without holding a reservation. Nothing to do.')
    return
  }
  console.log(`${rows.length} pay link(s) sell a stay and hold no reservation:\n`)
  for (const r of rows) {
    console.log(`  ${r.status.toUpperCase().padEnd(7)} ${r.property_name} — ${r.label}`)
    console.log(`          $${r.total} · ${r.customer_name ?? 'no name'} <${r.customer_email ?? 'no email'}>`)
    console.log(`          sent ${r.created_at}${r.paid_at ? `, paid ${r.paid_at}` : ', not paid'} · stay sold: ${r.stay_items}`)
    console.log(`          link ${r.id}`)
    console.log(r.status === 'paid'
      ? '          → MONEY WAS TAKEN AND NO STAY WAS PLACED. Check the schedule for this guest first.'
      : '          → will not open for payment any more. Reissue it from the register with a site and dates, then close this one.')
    console.log('')
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
