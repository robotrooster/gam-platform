/**
 * ── 10/29: A SCREENING DOCUMENT IS NEVER SERVED AS A DOCUMENT ───────────────
 *
 * Both screening upload routes named the stored file from
 * `path.extname(file.originalname)` and filtered on `file.mimetype` — both
 * client-supplied — and both serve routes removed the CSP and CORP headers and
 * called res.sendFile with no pinned Content-Type and no nosniff.
 *
 * An applicant could therefore upload a part declared image/png, named
 * "x.html", holding a script. It landed as <ts>-<hex>.html, passed the per-row
 * auth (correct, and unchanged), and when the LANDLORD screening them opened
 * it, express derived text/html from that extension and served it with no CSP
 * — the applicant's script running on the landlord portal's own origin.
 *
 * These are unit tests over the two helpers rather than route tests, because
 * what went wrong was the NAMING and the HEADERS, not the authorization. The
 * repo had closed this same shape four times before (S380, S394, S399, S409)
 * and these two paths were missed.
 */
import { describe, it, expect } from 'vitest'
import { screeningStoredName, sendScreeningFile } from './background'

describe('the stored name of a screening document', () => {
  it('takes its extension from the accepted type, never the filename', () => {
    // The attack: a declared image whose name says .html.
    const n = screeningStoredName({ mimetype: 'image/png', originalname: 'x.html' } as any)
    expect(n.endsWith('.png')).toBe(true)
    expect(n).not.toMatch(/\.html/i)
  })

  it('names each accepted type correctly', () => {
    expect(screeningStoredName({ mimetype: 'image/jpeg' } as any)).toMatch(/\.jpg$/)
    expect(screeningStoredName({ mimetype: 'image/png' } as any)).toMatch(/\.png$/)
    expect(screeningStoredName({ mimetype: 'application/pdf' } as any)).toMatch(/\.pdf$/)
  })

  /** Defence in depth: the filter should already have refused this. */
  it('falls back to an inert extension for a type that got past the filter', () => {
    expect(screeningStoredName({ mimetype: 'text/html' } as any)).toMatch(/\.bin$/)
  })

  it('is unguessable — random, not derived from the upload', () => {
    const a = screeningStoredName({ mimetype: 'image/png' } as any)
    const b = screeningStoredName({ mimetype: 'image/png' } as any)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^\d+-[0-9a-f]{16}\.png$/)
  })
})

describe('serving a screening document', () => {
  function fakeRes() {
    const headers: Record<string, string> = {}
    const removed: string[] = []
    return {
      headers, removed, sent: null as string | null,
      setHeader: (k: string, v: string) => { headers[k] = v },
      removeHeader: (k: string) => { removed.push(k) },
      sendFile: (p: string) => { (fakeRes as any)._p = p },
    }
  }

  it('pins the type from OUR extension and forbids sniffing', () => {
    const res = fakeRes()
    sendScreeningFile(res as any, '/uploads/id-documents/1730000000-aabbccddeeff0011.png')
    expect(res.headers['Content-Type']).toBe('image/png')
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
  })

  it('serves an unexpected extension as a download, not as a page', () => {
    const res = fakeRes()
    sendScreeningFile(res as any, '/uploads/id-documents/1730000000-aabbccddeeff0011.html')
    expect(res.headers['Content-Type']).toBe('application/octet-stream')
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
  })

  it('still drops the embed blockers, so the portal can show the document', () => {
    const res = fakeRes()
    sendScreeningFile(res as any, '/uploads/id-documents/1730000000-aabbccddeeff0011.pdf')
    expect(res.removed).toContain('Content-Security-Policy')
    expect(res.removed).toContain('Cross-Origin-Resource-Policy')
    expect(res.headers['Content-Type']).toBe('application/pdf')
  })
})
