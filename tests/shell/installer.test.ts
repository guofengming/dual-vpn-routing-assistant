import { describe, expect, it } from 'vitest'
import { runDaemonScript } from '../helpers/run-daemon-script'

describe('privileged service transaction', () => {
  it('does not claim a same-interface gateway host route during legacy migration', async () => {
    const result = await runDaemonScript(
      'migrate-legacy.sh',
      ['--test-current-route-match', 'host', '10.57.0.96', 'utun4', ''],
      'legacy-host-gateway-taken-over'
    )

    expect(result.exitCode).not.toBe(0)
  })

  it('prepares legacy cleanup before bootstrap but removes assets only after verification', async () => {
    const result = await runDaemonScript('install-helper.sh', ['--test-plan'], 'installer-success')

    expect(result.exitCode).toBe(0)
    expect(result.stdout.indexOf('operation=legacy-cleanup-bundled')).toBeLessThan(
      result.stdout.indexOf('operation=bootstrap-new')
    )
    expect(result.stdout.indexOf('operation=verify-running-service')).toBeLessThan(
      result.stdout.indexOf('operation=legacy-remove-files')
    )
    expect(result.stdout.indexOf('operation=legacy-remove-files')).toBeLessThan(
      result.stdout.indexOf('operation=installation-complete')
    )
  })

  it('does not install when bundled legacy restoration fails', async () => {
    const result = await runDaemonScript(
      'install-helper.sh',
      ['--test-plan'],
      'legacy-restore-failure'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=legacy-restore-network')
    expect(result.stdout).toContain('operation=legacy-restart-service')
    expect(result.stdout).not.toContain('operation=legacy-remove-files')
    expect(result.stdout).not.toContain('operation=install-service-files')
  })

  it('reports an incomplete rollback when legacy restoration and restart both fail', async () => {
    const result = await runDaemonScript(
      'install-helper.sh',
      ['--test-plan'],
      'legacy-rollback-failure'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=legacy-restore-network')
    expect(result.stdout).toContain('operation=legacy-restart-service')
    const failureLine = result.stdout.trim().split('\n').findLast((line) => line.startsWith('{'))
    expect(JSON.parse(failureLine ?? '{}')).toMatchObject({
      ok: false,
      action: 'install',
      errorCode: 'rollback_failed',
      daemonVersion: null
    })
  })

  it('restores route and DNS snapshots after a failed installation', async () => {
    const result = await runDaemonScript('install-helper.sh', ['--test-plan'], 'installer-failure')

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=snapshot-network')
    expect(result.stdout).toContain('operation=restore-network')
    expect(result.stdout).toContain('operation=restore-previous-service')
    expect(result.stdout).toContain('operation=legacy-restart-service')
    expect(result.stdout).not.toContain('operation=legacy-remove-files')
    expect(result.stdout).not.toContain('operation=installation-complete')
  })

  it('restarts the legacy service when the new baseline snapshot fails', async () => {
    const result = await runDaemonScript(
      'install-helper.sh',
      ['--test-plan'],
      'installer-snapshot-failure'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=snapshot-network')
    expect(result.stdout).toContain('operation=legacy-restart-service')
    expect(result.stdout).not.toContain('operation=install-service-files')
    expect(result.stdout).not.toContain('operation=legacy-remove-files')
  })

  it('rolls back when the launched daemon version and status cannot be verified', async () => {
    const result = await runDaemonScript(
      'install-helper.sh',
      ['--test-plan'],
      'installer-verification-failure'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=verify-running-service')
    expect(result.stdout).toContain('operation=restore-network')
    expect(result.stdout).toContain('operation=restore-previous-service')
    expect(result.stdout).toContain('operation=legacy-restart-service')
    expect(result.stdout).not.toContain('operation=installation-complete')
  })

  it('preserves the running daemon and backups when rollback cannot boot it out', async () => {
    const result = await runDaemonScript(
      'install-helper.sh',
      ['--test-plan'],
      'installer-rollback-stop-failure'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=bootstrap-new')
    expect(result.stdout).toContain('operation=verify-running-service')
    expect(result.stdout).toContain('operation=stop-rollback-service')
    expect(result.stdout).not.toContain('operation=restore-network')
    expect(result.stdout).not.toContain('operation=restore-previous-service')
    expect(result.stdout).not.toContain('operation=legacy-restart-service')
    expect(result.stdout).not.toContain('operation=legacy-remove-files')
    const failureLine = result.stdout.trim().split('\n').findLast((line) => line.startsWith('{'))
    expect(JSON.parse(failureLine ?? '{}')).toMatchObject({
      ok: false,
      action: 'install',
      errorCode: 'rollback_failed',
      daemonVersion: null
    })
  })

  it('keeps the recovery daemon and backups when network rollback is incomplete', async () => {
    const result = await runDaemonScript(
      'install-helper.sh',
      ['--test-plan'],
      'installer-rollback-cleanup-failure'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=verify-running-service')
    expect(result.stdout).toContain('operation=stop-rollback-service')
    expect(result.stdout).toContain('operation=restore-network')
    expect(result.stdout).not.toContain('operation=restore-previous-service')
    expect(result.stdout).not.toContain('operation=legacy-restart-service')
    expect(result.stdout).not.toContain('operation=legacy-remove-files')
    const failureLine = result.stdout.trim().split('\n').findLast((line) => line.startsWith('{'))
    expect(JSON.parse(failureLine ?? '{}')).toMatchObject({
      ok: false,
      action: 'install',
      errorCode: 'rollback_failed',
      daemonVersion: null
    })
  })

  it('removes a fresh daemon status after a verified clean installation rollback', async () => {
    const result = await runDaemonScript(
      'install-helper.sh',
      ['--test-plan'],
      'fresh-install-verify-failure'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=remove-stale-status')
    expect(result.stdout).not.toContain('operation=restore-previous-service')
  })

  it('propagates an earlier service-file installation failure', async () => {
    const result = await runDaemonScript(
      'install-helper.sh',
      ['--test-plan'],
      'installer-file-failure'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=install-service-files')
    expect(result.stdout).toContain('operation=restore-previous-service')
    expect(result.stdout).toContain('operation=legacy-restart-service')
    expect(result.stdout).not.toContain('operation=legacy-remove-files')
    expect(result.stdout).not.toContain('operation=bootstrap-new')

    const failureLine = result.stdout.trim().split('\n').findLast((line) => line.startsWith('{'))
    expect(JSON.parse(failureLine ?? '{}')).toMatchObject({
      ok: false,
      action: 'install',
      errorCode: 'service_files_failed',
      daemonVersion: null
    })
  })

  it('aborts and rolls back when an existing daemon cannot be booted out', async () => {
    const result = await runDaemonScript(
      'install-helper.sh',
      ['--test-plan'],
      'installer-stop-failure'
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=stop-new-service')
    expect(result.stdout).toContain('operation=legacy-restart-service')
    expect(result.stdout).not.toContain('operation=restore-previous-service')
    expect(result.stdout).not.toContain('operation=install-service-files')
    expect(result.stdout).not.toContain('operation=bootstrap-new')
  })

  it('does not remove service files when cleanup fails', async () => {
    const result = await runDaemonScript('uninstall-helper.sh', ['--test-plan'], 'uninstaller-failure')

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('operation=cleanup-network')
    expect(result.stdout).not.toContain('operation=bootout-service')
    expect(result.stdout).not.toContain('operation=remove-service-files')
  })

  it('removes service files only after successful cleanup', async () => {
    const result = await runDaemonScript('uninstall-helper.sh', ['--test-plan'], 'installer-success')

    expect(result.exitCode).toBe(0)
    expect(result.stdout.indexOf('operation=cleanup-network')).toBeLessThan(
      result.stdout.indexOf('operation=bootout-service')
    )
    expect(result.stdout.indexOf('operation=bootout-service')).toBeLessThan(
      result.stdout.indexOf('operation=remove-service-files')
    )
  })
})
