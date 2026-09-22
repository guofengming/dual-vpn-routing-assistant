import { describe, expect, it } from 'vitest'
import { ControlRequestSchema, DaemonStatusSchema } from '../../src/shared/protocol'

describe('ControlRequestSchema', () => {
  it('accepts a fixed repair request', () => {
    const request = ControlRequestSchema.parse({
      schemaVersion: 1,
      requestId: '018f6d76-ec4a-7d77-a9f2-0cbb48aa28a0',
      type: 'repairNow',
      createdAt: '2026-09-22T10:00:00.000Z'
    })

    expect(request.type).toBe('repairNow')
  })

  it('rejects arbitrary commands and paths', () => {
    expect(() => ControlRequestSchema.parse({
      schemaVersion: 1,
      requestId: '018f6d76-ec4a-7d77-a9f2-0cbb48aa28a0',
      type: 'exec',
      command: 'route delete default',
      path: '/tmp/tool',
      createdAt: '2026-09-22T10:00:00.000Z'
    })).toThrow()
  })
})

describe('DaemonStatusSchema', () => {
  it('rejects an unknown phase', () => {
    expect(() => DaemonStatusSchema.parse({ schemaVersion: 1, phase: 'BROKEN' })).toThrow()
  })
})
