/**
 * S601 booking-site importer — SSRF guard.
 *
 * The importer fetches an arbitrary landlord-supplied URL server-side, so the
 * private/reserved-address block is the load-bearing security control. IP-literal
 * URLs skip DNS, so these run with no network.
 */
import { describe, it, expect } from 'vitest'
import { isBlockedIp, assertPublicUrl } from './siteImport'

describe('isBlockedIp', () => {
  it('blocks private / loopback / link-local / reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1', '127.1.2.3',        // loopback
      '10.0.0.1', '10.255.255.255',    // private
      '172.16.0.1', '172.31.255.255',  // private
      '192.168.0.1',                   // private
      '169.254.169.254',               // link-local (cloud metadata)
      '100.64.0.1',                    // CGNAT
      '0.0.0.0',                       // this-net
      '224.0.0.1', '239.1.1.1',        // multicast
    ]) expect(isBlockedIp(ip), ip).toBe(true)
  })

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.0.1', '13.107.21.200']) {
      expect(isBlockedIp(ip), ip).toBe(false)
    }
  })

  it('blocks loopback / link-local / ULA / mapped IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('allows public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false)
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false)
  })
})

describe('assertPublicUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('ftp://example.com')).rejects.toThrow()
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow()
    await expect(assertPublicUrl('gopher://x')).rejects.toThrow()
  })

  it('rejects localhost and private/metadata IP literals', async () => {
    await expect(assertPublicUrl('http://localhost/')).rejects.toThrow()
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow()
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow()
    await expect(assertPublicUrl('http://10.0.0.5/')).rejects.toThrow()
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow()
  })

  it('rejects garbage', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow()
  })

  it('accepts a public IP-literal https URL', async () => {
    const u = await assertPublicUrl('https://8.8.8.8/')
    expect(u.hostname).toBe('8.8.8.8')
  })
})
