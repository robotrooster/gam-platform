import { useEffect, useState } from 'react'

// 10/13 (Nic): "phones = one card per household" on the Payments page. The
// page lays its rows out as a table or as cards — one or the other, never both
// in the page at once (an opened row's payments and charges are drawn once).
// The width matches the Rent Roll's cards (styles/rent-roll.css, 640px).
export const PHONE_QUERY = '(max-width: 640px)'

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches
}

/** Is the screen phone-sized? Follows the screen as it turns or resizes. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(matches)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(PHONE_QUERY)
    const on = () => setPhone(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return phone
}
