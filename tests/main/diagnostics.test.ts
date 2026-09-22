import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DaemonStatus } from '../../src/shared/protocol'
import { buildDiagnosticBundle, writePrivateDiagnosticFile } from '../../src/main/diagnostics'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const status: DaemonStatus = {
  schemaVersion: 1,
  phase: 'DEGRADED',
  message: '用户 guofengming 位于 /Users/guofengming',
  updatedAt: '2026-09-22T04:00:00Z',
  physicalInterface: 'en0',
  physicalGateway: '172.19.132.1',
  mobileInterface: 'utun4',
  routes: [],
  dns: {
    state: 'drifted',
    servers: ['172.31.5.60'],
    domains: ['baidu.com'],
    resolvedAddresses: ['10.11.154.217']
  },
  lastCheckAt: '2026-09-22T04:00:00Z',
  lastNetworkChangeAt: null,
  lastError: {
    code: 'sample',
    message: '/Users/guofengming/Library is unavailable for guofengming',
    occurredAt: '2026-09-22T04:00:00Z',
    retryable: true
  },
  autoEnableAtBoot: true,
  paused: false,
  daemonVersion: '0.1.0',
  processedRequestId: null,
  events: []
}

describe('diagnostic export', () => {
  it('redacts the home directory and console username while retaining useful enterprise addresses', () => {
    const bundle = buildDiagnosticBundle({
      status,
      appVersion: '0.1.0',
      homeDirectory: '/Users/guofengming',
      username: 'guofengming',
      logTail: 'install stage=service_files_failed for /Users/guofengming by guofengming'
    })

    expect(bundle).not.toContain('/Users/guofengming')
    expect(bundle).not.toContain('guofengming')
    expect(bundle).toContain('$USER_HOME')
    expect(bundle).toContain('$CONSOLE_USER')
    expect(bundle).toContain('172.31.5.60')
    expect(bundle).toContain('10.11.154.217')
    expect(bundle).toContain('install stage=service_files_failed')
  })

  it('forces an existing diagnostic file back to owner-only permissions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dual-vpn-diagnostics-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'existing.txt')
    await writeFile(destination, 'old', { mode: 0o644 })

    await writePrivateDiagnosticFile(destination, 'new')

    expect((await stat(destination)).mode & 0o777).toBe(0o600)
  })
})
