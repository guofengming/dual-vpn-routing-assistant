import { describe, expect, it } from 'vitest'
import type { DaemonStatus } from '../../src/shared/protocol'
import { buildDiagnosticBundle } from '../../src/main/diagnostics'

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
      username: 'guofengming'
    })

    expect(bundle).not.toContain('/Users/guofengming')
    expect(bundle).not.toContain('guofengming')
    expect(bundle).toContain('$USER_HOME')
    expect(bundle).toContain('$CONSOLE_USER')
    expect(bundle).toContain('172.31.5.60')
    expect(bundle).toContain('10.11.154.217')
  })
})
