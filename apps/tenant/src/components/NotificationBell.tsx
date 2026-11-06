/**
 * S655 (Nic, 10/30) — the tenant portal had NO bell and no reachable feed.
 *
 * The notifications themselves were real and piling up: 323 rows addressed to
 * 105 residents in production, every one unread, because there was nowhere to
 * read them. A Notifications page existed and was even wired into the router,
 * but nothing linked to it and it queried the renter-pool feed rather than the
 * resident one, so even typing the URL showed the wrong list.
 *
 * The count comes from the unread feed's own length rather than the endpoint's
 * unreadCount, because apiGet unwraps to `data` and drops its siblings. Capped
 * at the fetch limit, which is why it reads "50+" rather than a wrong number.
 */
import { useQuery } from 'react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { apiGet } from '../lib/api'

const LIMIT = 50

export function NotificationBell() {
  const navigate = useNavigate()
  const loc = useLocation()
  // 10/30 (Nic): "clicking the notification bell doesn't collapse the
  // notification menu at all. I have to click the home button to go off of it."
  // Tapping the bell while already ON the feed navigated to the same route,
  // which looks like a frozen page. It steps back out instead, so the bell
  // reads as a toggle.
  const onFeed = loc.pathname === '/notifications'
  const { data = [] } = useQuery<any[]>(
    'tenant-unread-notifications',
    () => apiGet<any[]>(`/notifications?unread=true&limit=${LIMIT}`).then(r => Array.isArray(r) ? r : []),
    { refetchInterval: 120000, staleTime: 60000, retry: false },
  )
  const n = data.length
  return (
    <button
      onClick={() => onFeed ? navigate(-1) : navigate('/notifications')}
      aria-label={onFeed ? 'Close notifications' : (n > 0 ? `Notifications, ${n} unread` : 'Notifications')}
      style={{ position: 'relative', border: 'none', cursor: 'pointer',
               color: 'var(--t2)', padding: 6, display: 'inline-flex', alignItems: 'center',
               borderRadius: 6, minWidth: 34, minHeight: 34, justifyContent: 'center',
               background: onFeed ? 'var(--bg-2)' : 'transparent' }}>
      <Bell size={16} style={{ color: onFeed ? 'var(--gold)' : undefined }} />
      {n > 0 && (
        <span style={{ position: 'absolute', top: 1, right: 1, minWidth: 15, height: 15,
                       padding: '0 3px', borderRadius: 8, background: 'var(--gold)', color: '#1a1a1a',
                       fontSize: '.58rem', fontWeight: 800, lineHeight: '15px', textAlign: 'center' }}>
          {n >= LIMIT ? `${LIMIT}+` : n}
        </span>
      )}
    </button>
  )
}
