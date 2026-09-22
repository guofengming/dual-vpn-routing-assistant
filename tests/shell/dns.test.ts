import { describe, expect, it } from 'vitest'
import { runDaemonScript } from '../helpers/run-daemon-script'

describe('owned supplemental DNS transaction', () => {
  it('uses only the declared servers and match domains', async () => {
    const result = await runDaemonScript('lib/dns.sh', ['--test-apply'], 'dns-owned')

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([
      [
        'dns-set',
        'State:/Network/Service/dual-vpn-routing-assistant-dns/DNS',
        '172.31.5.60,172.31.6.60',
        'baidu.com,baidu-int.com,internal.baidu.com'
      ]
    ])
  })

  it('preserves unrelated resolvers and removes only the app-owned key', async () => {
    const result = await runDaemonScript('lib/dns.sh', ['--test-sequence'], 'dns-owned')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('preserved_dns=State:/Network/Service/corporate-existing/DNS')
    expect(result.operations.at(-1)).toEqual([
      'dns-remove',
      'State:/Network/Service/dual-vpn-routing-assistant-dns/DNS'
    ])
    expect(result.stdout).not.toContain('operation=dns-remove|State:/Network/Service/corporate-existing/DNS')
  })

  it.each([
    'dns-set-restore-retry',
    'dns-verify-restore-retry',
    'dns-ownership-restore-retry'
  ])('keeps the pending journal when %s cannot restore immediately', async (fixture) => {
    const result = await runDaemonScript(
      'lib/dns.sh',
      ['--test-failure-restart'],
      fixture
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('pending_after_apply=true')
    expect(result.stdout).toContain('pending_after_restart=false')
    expect(result.stdout.match(/dns_restore_attempt=/g)).toHaveLength(2)
  })

  it('refuses a new DNS apply while a previous recovery is pending', async () => {
    const result = await runDaemonScript(
      'lib/dns.sh',
      ['--test-apply'],
      'active-dns-pending'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.operations).toEqual([])
  })
})
