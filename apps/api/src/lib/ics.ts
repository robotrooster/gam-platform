/**
 * RFC 5545 (iCalendar) primitives — shared by every ICS producer (business
 * appointments feed, sales/demo calendar feed, single-event booking
 * attachments). Pure string-building, no IO, trivially testable.
 *
 * Extracted S596 from services/calendarFeed.ts so the demo-booking feed and
 * the appointments feed can't drift on escaping / line-folding / UTC format.
 */

// RFC 5545 §3.3.11 — escape backslash, semicolon, comma, and newlines in TEXT.
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

// RFC 5545 §3.1 — fold lines longer than 75 octets; continuation lines start
// with a single space. Measured in UTF-8 bytes so multibyte chars don't break
// the limit. Simple and conservative.
export function foldIcsLine(line: string): string {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const out: string[] = []
  let cur = ''
  let curBytes = 0
  for (const ch of line) {
    const chBytes = enc.encode(ch).length
    // Account for the leading space on continuation lines (limit 74 there).
    const limit = out.length === 0 ? 75 : 74
    if (curBytes + chBytes > limit) {
      out.push(cur)
      cur = ch
      curBytes = chBytes
    } else {
      cur += ch
      curBytes += chBytes
    }
  }
  if (cur) out.push(cur)
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\r\n')
}

// → 20260622T143000Z
export function formatIcsUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

/** Assemble a VCALENDAR document from pre-built VEVENT line groups, applying
 *  line-folding + CRLF joins. `props` are top-level VCALENDAR properties. */
export function assembleVcalendar(props: string[], events: string[][]): string {
  const lines: string[] = ['BEGIN:VCALENDAR', ...props]
  for (const ev of events) lines.push(...ev)
  lines.push('END:VCALENDAR')
  return lines.map(foldIcsLine).join('\r\n') + '\r\n'
}
