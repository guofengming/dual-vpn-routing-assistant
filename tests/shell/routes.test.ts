import { describe, expect, it } from 'vitest'
import { runRouteScenario } from '../helpers/run-daemon-script'
import { runDaemonScript } from '../helpers/run-daemon-script'

describe('owned route transaction', () => {
  it('does not restore an IPv4 snapshot through an interface with only IPv6', async () => {
    const result = await runDaemonScript(
      'lib/routes.sh',
      ['--test-snapshot-restorable', 'stale-host.route'],
      'route-snapshot-ipv6-only'
    )

    expect(result.exitCode).not.toBe(0)
  })

  it('adds only two /9 routes and two mobile DNS host routes', async () => {
    const result = await runRouteScenario('apply-active')

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([
      ['add-net', '10.0.0.0/9', '172.19.132.1'],
      ['add-net', '10.128.0.0/9', '172.19.132.1'],
      ['add-host-if', '10.57.0.96', 'utun4'],
      ['add-host-if', '10.57.0.196', 'utun4']
    ])
    expect(result.finalManagedRoutes).toHaveLength(4)
    const snapshots = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('snapshot='))
    expect(snapshots).toHaveLength(4)
    expect(result.stdout.lastIndexOf('snapshot=')).toBeLessThan(
      result.stdout.indexOf('operation=add-net')
    )
  })

  it('rolls back this transaction when the fourth operation fails', async () => {
    const result = await runRouteScenario('fail-fourth-operation')

    expect(result.exitCode).not.toBe(0)
    expect(result.finalManagedRoutes).toEqual([])
    expect(result.stdout).toContain('restore_pending=net|10.0.0.0/9')
    expect(result.stdout.indexOf('restore_pending=net|10.0.0.0/9')).toBeLessThan(
      result.stdout.indexOf('operation=rollback-net|10.0.0.0/9')
    )
  })

  it('removes only routes that still match the persisted ownership ledger', async () => {
    const result = await runDaemonScript(
      'lib/routes.sh',
      ['--test-revert'],
      'routes-owned'
    )

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([
      ['rollback-net', '10.0.0.0/9'],
      ['rollback-host', '10.57.0.96']
    ])
  })

  it('does not delete a route that another network service has taken over', async () => {
    const result = await runDaemonScript(
      'lib/routes.sh',
      ['--test-revert'],
      'routes-taken-over'
    )

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([])
    expect(result.stdout).toContain('ownership_lost')
  })

  it('persists a restore journal before deleting an owned route', async () => {
    const result = await runDaemonScript(
      'lib/routes.sh',
      ['--test-revert'],
      'routes-owned'
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.indexOf('restore_pending=net|10.0.0.0/9')).toBeLessThan(
      result.stdout.indexOf('operation=rollback-net|10.0.0.0/9')
    )
  })

  it('resumes restoration after a crash that happened after route deletion', async () => {
    const result = await runDaemonScript(
      'lib/routes.sh',
      ['--test-revert'],
      'routes-restore-pending'
    )

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([])
    expect(result.stdout).toContain('restore=net|10.0.0.0/9')
    expect(result.stdout).not.toContain('ownership_lost')
  })

  it('refuses to apply new routes while a restore journal is pending', async () => {
    const result = await runRouteScenario('active-restore-pending')

    expect(result.exitCode).not.toBe(0)
    expect(result.operations).toEqual([])
    expect(result.stdout).not.toContain('snapshot=')
  })

  it('does not treat a gateway host route on the same interface as app-owned', async () => {
    const result = await runDaemonScript(
      'lib/routes.sh',
      ['--test-revert'],
      'routes-host-gateway-taken-over'
    )

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([])
    expect(result.stdout).toContain('ownership_lost')
  })

  it.each([
    ['net', '10.0.0.0/9', 'default.route'],
    ['net', '10.0.0.0/9', 'broad-10-8.route'],
    ['host', '10.57.0.96', 'broad-host.route']
  ])('treats an effective %s route from %s as ABSENT', async (kind, target, fixtureFile) => {
    const result = await runDaemonScript(
      'lib/routes.sh',
      ['--test-snapshot-policy', kind, target, fixtureFile],
      'route-snapshot-policy'
    )

    expect(result.exitCode).not.toBe(0)
  })

  it.each([
    ['net', '10.0.0.0/9', 'exact-net.route'],
    ['host', '10.57.0.96', 'exact-host.route']
  ])('recognizes an exact preexisting %s route for restoration', async (kind, target, fixtureFile) => {
    const result = await runDaemonScript(
      'lib/routes.sh',
      ['--test-snapshot-policy', kind, target, fixtureFile],
      'route-snapshot-policy'
    )

    expect(result.exitCode).toBe(0)
  })
})
