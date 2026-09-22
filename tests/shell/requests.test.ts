import { describe, expect, it } from 'vitest'
import { runDaemonScript } from '../helpers/run-daemon-script'

describe('daemon request validation', () => {
  it.each([
    'wrong-owner',
    'loose-directory',
    'symlink-directory',
    'symlink',
    'unknown-field',
    'unknown-type',
    'reused',
    'older-replay',
    'non-console-user'
  ])('rejects %s requests', async (scenario) => {
    const result = await runDaemonScript(
      'lib/requests.sh',
      ['--test-consume', scenario],
      'requests'
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain('accepted=')
  })

  it.each([
    ['valid-repair', 'repairNow'],
    ['valid-pause', 'setPaused'],
    ['valid-auto', 'setAutoEnableAtBoot'],
    ['valid-log', 'setLogLevel']
  ])('accepts only declared request %s', async (scenario, type) => {
    const result = await runDaemonScript(
      'lib/requests.sh',
      ['--test-consume', scenario],
      'requests'
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`accepted=${type}`)
  })

  it('applies an accepted request through the daemon without evaluating input', async () => {
    const result = await runDaemonScript(
      'daemon.sh',
      ['--test-request', 'valid-pause'],
      'requests'
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('config=paused|true')
    expect(result.stdout).toContain('processed_request=22222222-2222-4222-8222-222222222222')
  })

  it('moves the request into a root-owned inbox before validating the file', async () => {
    const result = await runDaemonScript(
      'lib/requests.sh',
      ['--test-consume', 'valid-repair'],
      'requests'
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.indexOf('operation=stage-request')).toBeLessThan(
      result.stdout.indexOf('operation=validate-staged-request')
    )
  })
})
