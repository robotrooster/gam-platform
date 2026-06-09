/**
 * AES-256-GCM encryption for bank account numbers.
 *
 * Format: base64(iv || authTag || ciphertext)
 * Key:    BANK_ENCRYPTION_KEY env var, 64 hex chars (32 bytes).
 *         Generate with: node -e "logger.info(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Decryption only happens server-side at payout-fire time. UI never sees the
 * full account number — only account_number_last4. Encrypted blob is never
 * logged.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { logger } from './logger'

const ALGO = 'aes-256-gcm'
const IV_LENGTH = 12        // GCM standard
const AUTH_TAG_LENGTH = 16

function getKey(): Buffer {
  const keyHex = process.env.BANK_ENCRYPTION_KEY
  if (!keyHex) {
    throw new Error(
      'BANK_ENCRYPTION_KEY env var not set. Generate with: ' +
      `node -e "logger.info(require('crypto').randomBytes(32).toString('hex'))"`
    )
  }
  if (keyHex.length !== 64) {
    throw new Error(`BANK_ENCRYPTION_KEY must be 64 hex chars (32 bytes), got ${keyHex.length}`)
  }
  return Buffer.from(keyHex, 'hex')
}

export function encryptBankAccountNumber(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString('base64')
}

export function decryptBankAccountNumber(payload: string): string {
  const key = getKey()
  const buf = Buffer.from(payload, 'base64')
  const iv = buf.subarray(0, IV_LENGTH)
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export function last4(accountNumber: string): string {
  const cleaned = accountNumber.replace(/\D/g, '')
  if (cleaned.length < 4) {
    throw new Error('Account number too short to extract last 4 digits')
  }
  return cleaned.slice(-4)
}
