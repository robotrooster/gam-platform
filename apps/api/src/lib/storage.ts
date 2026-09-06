/**
 * Storage seam (GCP migration Phase A1) — every persistent file the API keeps
 * (signed leases, tenant ID scans, inspection media, receipts, avatars, …)
 * goes through this module instead of touching `uploads/` directly.
 *
 * Two drivers, chosen by STORAGE_DRIVER:
 *   local (default) — files under UPLOADS_ROOT (default <cwd>/uploads),
 *     byte-for-byte the pre-seam layout, so the Mac deployment is unchanged
 *     and existing files need no migration.
 *   gcs — objects in GCS_UPLOADS_BUCKET via Application Default Credentials.
 *
 * KEYS, not paths. A key is a '/'-joined relative path ('leases/f.pdf',
 * 'business-attachments/<bizId>/<file>'). Stored DB strings are unchanged —
 * they remain API-route URLs or bare filenames — and routes derive the key
 * with uploadKeyFromStored(subdir, stored). That keeps the refactor free of
 * any data migration: the key scheme IS today's directory scheme.
 *
 * Drivers create parent "directories" implicitly on write. This is what
 * retired the 21 module-load mkdir calls that would crash boot on a
 * read-only container filesystem.
 *
 * NOTE ON NAMES: lib/uploadPaths.ts and lib/fileServe.ts both exported a
 * `resolveUploadPath` with incompatible signatures. This module deliberately
 * exports NO function of that name.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import type { Readable } from 'stream'
import type { Response } from 'express'
import { AppError } from '../middleware/errorHandler'
import { logger } from './logger'

/** Thrown by drivers on a missing key; mapped to AppError(404) by senders. */
export class StorageNotFoundError extends Error {
  constructor(key: string) { super(`no stored file for key: ${key}`) }
}

export interface OpenedFile {
  stream: Readable
  size?: number
}

export interface StorageDriver {
  save(key: string, data: Buffer): Promise<void>
  /** Move an already-on-disk temp file (large multer disk-staged uploads —
   *  500MB videos must never transit memory) into storage. Consumes tmpPath. */
  saveFromFile(tmpPath: string, key: string): Promise<void>
  /** Open for reading. Throws StorageNotFoundError when absent. */
  open(key: string, range?: { start: number; end?: number }): Promise<OpenedFile>
  exists(key: string): Promise<boolean>
  /** Idempotent: removing an absent key is a no-op. */
  remove(key: string): Promise<void>
  move(srcKey: string, destKey: string): Promise<void>
  /** local driver only: absolute path for res.sendFile fast-path. */
  localPathFor?(key: string): string
}

// Same per-segment charset the old uploadPaths guard enforced, extended with
// '/' as the joiner. No '..' segments, no absolute/emtpy keys, no backslash.
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/

export function isValidKey(key: string): boolean {
  if (!key || key.startsWith('/') || key.includes('\\')) return false
  const segments = key.split('/')
  return segments.every((s) => s.length > 0 && s !== '..' && s !== '.' && SEGMENT_RE.test(s))
}

function assertKey(key: string): void {
  if (!isValidKey(key)) throw new AppError(400, 'Bad file path')
}

/**
 * Derive the storage key for a stored DB string: <subdir>/<basename>.
 * Successor to uploadPaths.extractUploadFilename + resolveUploadPath — the
 * stored value may be an API-route URL, a legacy '/uploads/...' url, or a
 * bare filename; only its basename is trusted, the subdir is the route's own
 * constant. Returns null (never throws) on anything malformed, matching the
 * old guard's contract.
 */
export function uploadKeyFromStored(subdir: string, stored: string | null | undefined): string | null {
  if (!stored) return null
  const name = path.basename(stored)
  if (!name || !SEGMENT_RE.test(name)) return null
  const key = `${subdir}/${name}`
  return isValidKey(key) ? key : null
}

/** Random collision-proof filename, preserving the (guarded) extension. */
export function newStoredFilename(originalName: string): string {
  const ext = path.extname(originalName || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10)
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`
}

// ── local driver ─────────────────────────────────────────────────────────

export function createLocalDriver(root: string): StorageDriver {
  const absFor = (key: string): string => {
    assertKey(key)
    const abs = path.resolve(root, key)
    if (!abs.startsWith(path.resolve(root) + path.sep)) throw new AppError(400, 'Bad file path')
    return abs
  }
  return {
    async save(key, data) {
      const abs = absFor(key)
      await fs.promises.mkdir(path.dirname(abs), { recursive: true })
      await fs.promises.writeFile(abs, data)
    },
    async saveFromFile(tmpPath, key) {
      const abs = absFor(key)
      await fs.promises.mkdir(path.dirname(abs), { recursive: true })
      try {
        await fs.promises.rename(tmpPath, abs)
      } catch (e: any) {
        if (e?.code !== 'EXDEV') throw e
        await fs.promises.copyFile(tmpPath, abs)
        await fs.promises.unlink(tmpPath).catch(() => {})
      }
    },
    async open(key, range) {
      const abs = absFor(key)
      let size: number
      try { size = (await fs.promises.stat(abs)).size } catch { throw new StorageNotFoundError(key) }
      const stream = fs.createReadStream(abs, range ? { start: range.start, end: range.end } : undefined)
      return { stream, size }
    },
    async exists(key) {
      try { await fs.promises.access(absFor(key)); return true } catch { return false }
    },
    async remove(key) {
      await fs.promises.unlink(absFor(key)).catch((e) => { if (e?.code !== 'ENOENT') throw e })
    },
    async move(srcKey, destKey) {
      const src = absFor(srcKey); const dest = absFor(destKey)
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      try {
        await fs.promises.rename(src, dest)
      } catch (e: any) {
        if (e?.code !== 'EXDEV') throw e
        await fs.promises.copyFile(src, dest)
        await fs.promises.unlink(src).catch(() => {})
      }
    },
    localPathFor: absFor,
  }
}

// ── gcs driver ───────────────────────────────────────────────────────────

export function createGcsDriver(bucketName: string): StorageDriver {
  // Lazy import keeps the SDK out of the boot path for local deployments.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Storage } = require('@google-cloud/storage')
  const bucket = new Storage().bucket(bucketName)
  const fileFor = (key: string) => { assertKey(key); return bucket.file(key) }
  const isNotFound = (e: any) => e?.code === 404
  return {
    async save(key, data) { await fileFor(key).save(data, { resumable: false }) },
    async saveFromFile(tmpPath, key) {
      assertKey(key)
      await bucket.upload(tmpPath, { destination: key })
      await fs.promises.unlink(tmpPath).catch(() => {})
    },
    async open(key, range) {
      const f = fileFor(key)
      let size: number | undefined
      try { size = Number((await f.getMetadata())[0].size) } catch (e: any) {
        if (isNotFound(e)) throw new StorageNotFoundError(key)
        throw e
      }
      const stream = f.createReadStream(range ? { start: range.start, end: range.end } : undefined)
      return { stream, size }
    },
    async exists(key) { return (await fileFor(key).exists())[0] },
    async remove(key) {
      try { await fileFor(key).delete() } catch (e: any) { if (!isNotFound(e)) throw e }
    },
    async move(srcKey, destKey) {
      // copy+delete — NOT atomic like the local rename. The one cross-subdir
      // caller (leaseParser resolveIntent) runs post-commit and tolerates a
      // partial move (its next run finds the copy and the source guard is an
      // exists() check), so this is acceptable.
      await fileFor(srcKey).move(fileFor(destKey))
    },
  }
}

// ── the configured driver ────────────────────────────────────────────────

export const UPLOADS_ROOT = process.env.UPLOADS_ROOT || path.join(process.cwd(), 'uploads')

function buildDriver(): StorageDriver {
  const kind = process.env.STORAGE_DRIVER || 'local'
  if (kind === 'gcs') {
    const bucket = process.env.GCS_UPLOADS_BUCKET
    if (!bucket) throw new Error('STORAGE_DRIVER=gcs requires GCS_UPLOADS_BUCKET')
    logger.info({ bucket }, '[storage] gcs driver')
    return createGcsDriver(bucket)
  }
  if (kind !== 'local') throw new Error(`Unknown STORAGE_DRIVER: ${kind}`)
  return createLocalDriver(UPLOADS_ROOT)
}

export const storage: StorageDriver = buildDriver()

/** Whole-file read for parse/merge paths (pdf merges, proof verification).
 *  Throws StorageNotFoundError when absent. */
export async function readStoredFile(key: string): Promise<Buffer> {
  const { stream } = await storage.open(key)
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/** Directory for multer disk-staging of large uploads before saveFromFile. */
export function uploadStagingDir(): string {
  const dir = path.join(os.tmpdir(), 'gam-upload-staging')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── the one streaming responder ──────────────────────────────────────────

export interface SendOptions {
  mimeType?: string | null
  cacheControl?: string
  /** Content-Disposition value (e.g. attachment; filename="x.pdf") */
  disposition?: string
  /** allow embedding cross-origin (public listing/storefront photos) */
  exposeCrossOrigin?: boolean
  /** drop CSP/CORP set by upstream middleware (id-documents viewer) */
  stripEmbedBlockers?: boolean
}

/**
 * Stream an already-AUTHORIZED stored file to the response — the successor
 * to fileServe.streamStoredFile and the 17 hand-rolled
 * resolve→existsSync→sendFile blocks. Authorization is the caller's job,
 * exactly as before. 404s (never 500s) on a missing object.
 *
 * Local driver takes the res.sendFile fast-path so ETag / Last-Modified /
 * Range behavior is byte-identical to today (inspection videos rely on
 * Range). Non-local drivers stream with explicit headers and honor a single
 * Range header (enough for video seek).
 */
export async function sendStoredFile(
  res: Response,
  key: string | null,
  opts: SendOptions = {},
): Promise<void> {
  if (!key) throw new AppError(404, 'No stored file for this record')
  assertKey(key)
  if (opts.stripEmbedBlockers) {
    res.removeHeader('Content-Security-Policy')
    res.removeHeader('Cross-Origin-Resource-Policy')
  }
  if (opts.exposeCrossOrigin) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  if (opts.cacheControl) res.setHeader('Cache-Control', opts.cacheControl)
  if (opts.disposition) res.setHeader('Content-Disposition', opts.disposition)
  if (opts.mimeType) res.type(opts.mimeType)

  if (storage.localPathFor) {
    const abs = storage.localPathFor(key)
    if (!fs.existsSync(abs)) throw new AppError(404, 'The file behind this record is missing')
    await new Promise<void>((resolve, reject) => {
      res.sendFile(abs, (err) => (err ? reject(err) : resolve()))
    })
    return
  }

  const rangeHeader = res.req?.headers.range
  let range: { start: number; end?: number } | undefined
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader)
    if (m) range = { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined }
  }
  let opened: OpenedFile
  try {
    opened = await storage.open(key, range)
  } catch (e) {
    if (e instanceof StorageNotFoundError) throw new AppError(404, 'The file behind this record is missing')
    throw e
  }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Accept-Ranges', 'bytes')
  if (range && opened.size !== undefined) {
    const end = range.end ?? opened.size - 1
    res.status(206)
    res.setHeader('Content-Range', `bytes ${range.start}-${end}/${opened.size}`)
    res.setHeader('Content-Length', end - range.start + 1)
  } else if (opened.size !== undefined) {
    res.setHeader('Content-Length', opened.size)
  }
  await new Promise<void>((resolve, reject) => {
    opened.stream.on('error', reject)
    res.on('close', resolve)
    opened.stream.pipe(res).on('finish', resolve)
  })
}
