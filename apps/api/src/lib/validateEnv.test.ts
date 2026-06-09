/**
 * Boot-time env validation — S280.
 */

import { describe, it, expect } from 'vitest'
import { validateEnv, EnvValidationError } from './validateEnv'

describe('validateEnv', () => {
  it('throws EnvValidationError when JWT_SECRET is unset', () => {
    const saved = process.env.JWT_SECRET
    delete process.env.JWT_SECRET
    try {
      expect(() => validateEnv()).toThrow(EnvValidationError)
      expect(() => validateEnv()).toThrow(/JWT_SECRET/)
    } finally {
      if (saved !== undefined) process.env.JWT_SECRET = saved
    }
  })

  it('no-op when JWT_SECRET is set', () => {
    const saved = process.env.JWT_SECRET
    process.env.JWT_SECRET = 'test-secret'
    try {
      expect(() => validateEnv()).not.toThrow()
    } finally {
      if (saved !== undefined) process.env.JWT_SECRET = saved
      else delete process.env.JWT_SECRET
    }
  })
})
