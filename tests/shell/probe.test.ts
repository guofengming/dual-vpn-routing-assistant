import { describe, expect, it } from 'vitest'
import { runProbeFixture } from '../helpers/run-daemon-script'

function readValue(output: string, key: string): string {
  return output
    .split('\n')
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1) ?? ''
}

describe('macOS network probe', () => {
  it('treats a plist-only utun as disconnected', async () => {
    const result = await runProbeFixture('stale-utun')

    expect(result.exitCode).toBe(0)
    expect(readValue(result.stdout, 'mobile_if')).toBe('')
    expect(result.stderr).toBe('')
  })

  it('returns the active physical gateway and live utun', async () => {
    const result = await runProbeFixture('active')

    expect(result.exitCode).toBe(0)
    expect(readValue(result.stdout, 'physical_if')).toBe('en0')
    expect(readValue(result.stdout, 'physical_gw')).toBe('172.19.132.1')
    expect(readValue(result.stdout, 'mobile_if')).toBe('utun4')
  })

  it('keeps an absent VPN as a quiet idle condition', async () => {
    const result = await runProbeFixture('idle')

    expect(result.exitCode).toBe(0)
    expect(readValue(result.stdout, 'mobile_if')).toBe('')
    expect(result.stderr).toBe('')
  })
})
