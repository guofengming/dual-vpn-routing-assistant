import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DaemonStatus } from '../../src/shared/protocol'
import { DaemonClient } from '../../src/main/daemon-client'

const tempRoots: string[] = []

async function tempPaths() {
  const root = await mkdtemp(path.join(tmpdir(), 'dual-vpn-client-'))
  tempRoots.push(root)
  const requestDirectory = path.join(root, 'ipc')
  await mkdir(requestDirectory, { mode: 0o700 })
  return {
    statusPath: path.join(root, 'status.json'),
    requestDirectory
  }
}

function activeStatus(): DaemonStatus {
  return {
    schemaVersion: 1,
    phase: 'ACTIVE',
    message: '分流矩阵稳定',
    updatedAt: '2026-09-22T04:00:00Z',
    physicalInterface: 'en0',
    physicalGateway: '172.19.132.1',
    mobileInterface: 'utun4',
    routes: [],
    dns: {
      state: 'correct',
      servers: ['172.31.5.60', '172.31.6.60'],
      domains: ['baidu.com'],
      resolvedAddresses: ['10.11.154.217']
    },
    lastCheckAt: '2026-09-22T04:00:00Z',
    lastNetworkChangeAt: null,
    lastError: null,
    autoEnableAtBoot: true,
    paused: false,
    daemonVersion: '0.1.0',
    processedRequestId: null,
    events: []
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DaemonClient', () => {
  it('parses a valid daemon status', async () => {
    const paths = await tempPaths()
    await writeFile(paths.statusPath, JSON.stringify(activeStatus()))
    const client = new DaemonClient(paths)

    await expect(client.readStatus()).resolves.toMatchObject({ phase: 'ACTIVE' })
  })

  it('returns safe synthetic states for missing and invalid status', async () => {
    const paths = await tempPaths()
    const client = new DaemonClient(paths)
    await expect(client.readStatus()).resolves.toMatchObject({ phase: 'UNINSTALLED' })

    await writeFile(paths.statusPath, '{"message":"raw secret", "phase":"ACTIVE"}')
    const invalid = await client.readStatus()
    expect(invalid.phase).toBe('DEGRADED')
    expect(invalid.message).not.toContain('raw secret')
  })

  it('validates and atomically writes a mode-0600 request', async () => {
    const paths = await tempPaths()
    const client = new DaemonClient(paths)
    const request = {
      schemaVersion: 1 as const,
      type: 'repairNow' as const,
      requestId: '88888888-8888-4888-8888-888888888888',
      createdAt: '2026-09-22T04:00:00Z'
    }

    await client.send(request)
    const requestPath = path.join(paths.requestDirectory, 'request.json')
    expect(JSON.parse(await readFile(requestPath, 'utf8'))).toEqual(request)
    const { stat } = await import('node:fs/promises')
    expect((await stat(requestPath)).mode & 0o777).toBe(0o600)
  })

  it('rejects unknown request fields before writing', async () => {
    const paths = await tempPaths()
    const client = new DaemonClient(paths)
    await expect(client.send({
      schemaVersion: 1,
      type: 'repairNow',
      requestId: '99999999-9999-4999-8999-999999999999',
      createdAt: '2026-09-22T04:00:00Z',
      command: 'unexpected'
    } as never)).rejects.toThrow()
  })

  it('never overwrites an already pending request', async () => {
    const paths = await tempPaths()
    const requestPath = path.join(paths.requestDirectory, 'request.json')
    await writeFile(requestPath, '{"existing":true}\n', { mode: 0o600 })
    const client = new DaemonClient(paths)

    await expect(client.send({
      schemaVersion: 1,
      type: 'repairNow',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-22T04:00:00Z'
    })).rejects.toThrow('已有控制请求')
    expect(await readFile(requestPath, 'utf8')).toBe('{"existing":true}\n')
  })
})
