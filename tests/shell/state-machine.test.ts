import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DaemonStatusSchema } from '../../src/shared/protocol'
import { runDaemonScript } from '../helpers/run-daemon-script'

const daemonVersion = readFileSync(path.join(process.cwd(), 'resources/daemon/VERSION'), 'utf8').trim()

async function transition(current: string, event: string): Promise<string> {
  const result = await runDaemonScript(
    'lib/state-machine.sh',
    ['--transition', current, event],
    'idle'
  )
  expect(result.exitCode).toBe(0)
  return result.stdout.trim()
}

describe('recovery state machine', () => {
  it.each([
    ['IDLE', 'vpn_up', 'PROBING'],
    ['PROBING', 'verification_ok', 'ACTIVE'],
    ['ACTIVE', 'vpn_down', 'IDLE'],
    ['ACTIVE', 'network_changed', 'NETWORK_SETTLING'],
    ['NETWORK_SETTLING', 'stable', 'PROBING'],
    ['ACTIVE', 'pause', 'PAUSED'],
    ['IDLE', 'pause', 'PAUSED'],
    ['PAUSED', 'resume', 'PROBING'],
    ['DEGRADED', 'environment_change', 'PROBING'],
    ['REPAIRING', 'repair_failed_4', 'DEGRADED']
  ])('%s + %s -> %s', async (current, event, expected) => {
    expect(await transition(current, event)).toBe(expected)
  })

  it.each([
    [1, '2'],
    [2, '5'],
    [3, '10']
  ])('uses bounded retry delay %i', async (attempt, expected) => {
    const result = await runDaemonScript(
      'lib/state-machine.sh',
      ['--retry', String(attempt)],
      'idle'
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(expected)
  })

  it('has no fourth automatic retry', async () => {
    const result = await runDaemonScript('lib/state-machine.sh', ['--retry', '4'], 'idle')
    expect(result.exitCode).not.toBe(0)
  })

  it('holds DEGRADED without further network writes until the environment changes', async () => {
    const result = await runDaemonScript('daemon.sh', ['--test-degraded-hold'], 'active')

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([])
    expect(result.stdout.match(/phase=DEGRADED/g)).toHaveLength(1)
  })

  it('latches a cleanup failure instead of retrying it every loop', async () => {
    const result = await runDaemonScript(
      'daemon.sh',
      ['--test-cleanup-degraded-hold'],
      'cleanup-failure'
    )

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([['cleanup-attempt']])
    expect(result.stdout.match(/phase=DEGRADED/g)).toHaveLength(1)
  })

  it('cleans managed state before settling a changed network', async () => {
    const result = await runDaemonScript(
      'daemon.sh',
      ['--test-events', 'IDLE', 'vpn_up', 'verification_ok', 'network_changed'],
      'network-change'
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('phase=NETWORK_SETTLING')
    expect(result.stdout.indexOf('operation=cleanup')).toBeLessThan(
      result.stdout.indexOf('phase=NETWORK_SETTLING')
    )
  })

  it('keeps an absent VPN quiet in IDLE', async () => {
    const result = await runDaemonScript('daemon.sh', ['--test-reconcile'], 'idle')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('phase=IDLE')
    expect(result.stderr).toBe('')
    expect(result.operations).toEqual([])
  })

  it('recovers a persisted pending route transaction even when starting in IDLE', async () => {
    const result = await runDaemonScript('daemon.sh', ['--test-reconcile'], 'crash-pending')

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([['rollback-net', '10.0.0.0/9']])
    expect(result.stdout).toContain('phase=IDLE')
  })

  it('finishes a crashed route restore before settling an otherwise active network', async () => {
    const result = await runDaemonScript(
      'daemon.sh',
      ['--test-reconcile'],
      'active-restore-pending'
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('restore=net|10.0.0.0/9')
    expect(result.stdout).toContain('phase=NETWORK_SETTLING')
    expect(result.stdout).not.toContain('snapshot=')
    expect(result.stdout).not.toContain('operation=add-net')
  })

  it('finishes a crashed DNS restore before settling an otherwise active network', async () => {
    const result = await runDaemonScript(
      'daemon.sh',
      ['--test-reconcile'],
      'active-dns-pending'
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('dns_restore_attempt=1')
    expect(result.stdout).toContain('phase=NETWORK_SETTLING')
    expect(result.stdout).not.toContain('operation=dns-set')
  })

  it('waits for a first network signature to remain stable before writing', async () => {
    const result = await runDaemonScript('daemon.sh', ['--test-reconcile'], 'active')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('phase=NETWORK_SETTLING')
    expect(result.operations).toEqual([])
  })

  it('does not report ACTIVE when both intranet HTTPS backends are unreachable', async () => {
    const result = await runDaemonScript(
      'daemon.sh',
      ['--test-backend-failure'],
      'backend-unreachable'
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('phase=ACTIVE')
    expect(result.stdout).toContain('phase=REPAIRING')
  })

  it('does not rewrite routes or DNS while ACTIVE remains healthy', async () => {
    const result = await runDaemonScript('daemon.sh', ['--test-steady-active'], 'active')

    expect(result.exitCode).toBe(0)
    expect(result.operations).toEqual([])
    expect(result.stdout.match(/phase=ACTIVE/g)).toHaveLength(1)
  })

  it('leaves ACTIVE when family.baidu.com no longer resolves to the intranet', async () => {
    const result = await runDaemonScript(
      'daemon.sh',
      ['--test-steady-active'],
      'dns-drift-active'
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('phase=PROBING')
    expect(result.stdout).toContain('phase=REPAIRING')
  })

  it('writes schema-valid JSON with a structured transition event', async () => {
    const result = await runDaemonScript('daemon.sh', ['--test-status', 'ACTIVE'], 'active')

    expect(result.exitCode).toBe(0)
    const line = result.stdout.split('\n').find((value) => value.startsWith('status_json='))
    const parsed = DaemonStatusSchema.parse(JSON.parse(line?.slice('status_json='.length) ?? ''))
    expect(parsed.phase).toBe('ACTIVE')
    expect(parsed.daemonVersion).toBe(daemonVersion)
    expect(parsed.events).toMatchObject([{ code: 'phase_active', level: 'info' }])
  })
})
