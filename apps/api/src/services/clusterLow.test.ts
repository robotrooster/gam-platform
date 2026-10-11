/**
 * S647 (Nic, DIRECTIVE): a stuck meter bills "the low end of the cluster" —
 * not the single lowest household, which is usually an outlier.
 */
import { describe, it, expect } from 'vitest'
import { clusterLow } from './utilityBilling'

describe('clusterLow', () => {
  it('lands where Nic put it on Mountain View\'s August electric', () => {
    // Occupied spaces with real usage, ascending. Randall Cox (120) and David
    // Shultz (197) are the two outliers below the group.
    const august = [120, 197, 387, 461, 592, 600, 677, 802, 891, 1079, 1259]
    expect(clusterLow(august)).toBe(387)
  })

  it('is always a usage somebody actually had', () => {
    const xs = [100, 250, 400, 900]
    expect(xs).toContain(clusterLow(xs))
  })

  it('falls back to the only household when there is one', () => {
    expect(clusterLow([300])).toBe(300)
  })

  it('refuses an empty list rather than inventing a number', () => {
    expect(() => clusterLow([])).toThrow()
  })
})
