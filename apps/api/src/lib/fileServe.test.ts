import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs'
import { resolveUploadPath, streamStoredFile } from './fileServe'

const uploadsRoot = path.join(process.cwd(), 'uploads')

describe('resolveUploadPath — path-traversal guard', () => {
  it('resolves a normal /uploads/ url under the uploads root', () => {
    const abs = resolveUploadPath('/uploads/docs/report.pdf')
    expect(abs).toBe(path.join(uploadsRoot, 'docs', 'report.pdf'))
    expect(abs.startsWith(uploadsRoot + path.sep)).toBe(true)
  })

  it('refuses a traversal that escapes the uploads root', () => {
    expect(() => resolveUploadPath('/uploads/../../etc/passwd')).toThrow()
    expect(() => resolveUploadPath('/uploads/../../../root/.ssh/id_rsa')).toThrow()
  })

  it('refuses a url that is not under /uploads/', () => {
    expect(() => resolveUploadPath('/etc/passwd')).toThrow()
    expect(() => resolveUploadPath('docs/report.pdf')).toThrow()
  })

  it('refuses a null/empty url', () => {
    expect(() => resolveUploadPath(null)).toThrow()
    expect(() => resolveUploadPath(undefined)).toThrow()
    expect(() => resolveUploadPath('')).toThrow()
  })
})

describe('streamStoredFile', () => {
  const fakeRes = () => {
    const calls: any = { type: null as any, sent: null as any }
    return {
      res: { type: (t: string) => { calls.type = t }, sendFile: (p: string) => { calls.sent = p } } as any,
      calls,
    }
  }

  it('404s when the row points at a file that was never written', () => {
    const { res } = fakeRes()
    expect(() => streamStoredFile(res, '/uploads/docs/does-not-exist.pdf', 'application/pdf')).toThrow()
  })

  it('sets the mime type and streams a real file', () => {
    // write a throwaway file under uploads/ to exercise the happy path
    const dir = path.join(uploadsRoot, 'docs')
    fs.mkdirSync(dir, { recursive: true })
    const name = `fileserve-test-${process.pid}.txt`
    const abs = path.join(dir, name)
    fs.writeFileSync(abs, 'hi')
    try {
      const { res, calls } = fakeRes()
      streamStoredFile(res, `/uploads/docs/${name}`, 'text/plain')
      expect(calls.type).toBe('text/plain')
      expect(calls.sent).toBe(abs)
    } finally {
      fs.rmSync(abs, { force: true })
    }
  })
})
